import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import http from "node:http";
import { join, resolve } from "node:path";
import os from "node:os";
import { spawn, spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..", "..");

function extractQuotedListBlock(text, marker) {
  const start = text.indexOf(marker);
  assert.notEqual(start, -1, `missing list marker: ${marker}`);
  const open = text.indexOf("(", start);
  const close = text.indexOf(")", open);
  assert.notEqual(open, -1, `missing list open: ${marker}`);
  assert.notEqual(close, -1, `missing list close: ${marker}`);
  return [...text.slice(open, close).matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

function extractJsSetBlock(text, marker) {
  const start = text.indexOf(marker);
  assert.notEqual(start, -1, `missing set marker: ${marker}`);
  const open = text.indexOf("[", start);
  const close = text.indexOf("]", open);
  assert.notEqual(open, -1, `missing set open: ${marker}`);
  assert.notEqual(close, -1, `missing set close: ${marker}`);
  return [...text.slice(open, close).matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

function waitForServerUrl(child) {
  return new Promise((resolveUrl, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("fake verifier server did not start")), 5000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.stdout.on("data", (chunk) => {
      output += chunk.toString("utf8");
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) {
        clearTimeout(timer);
        resolveUrl(match[0]);
      }
    });
  });
}

function listenOnLoopback(server) {
  return new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolveListen(`http://127.0.0.1:${server.address().port}`));
  });
}

function closeServer(server) {
  return new Promise((resolveClose) => {
    if (!server.listening) return resolveClose();
    server.close(() => resolveClose());
  });
}

function runChildProcess(command, args, { timeoutMs = 20000 } = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let spawnError = null;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", (status, signal) => {
      clearTimeout(timer);
      resolveRun({
        status,
        signal,
        stdout,
        stderr,
        error: spawnError || (timedOut ? new Error(`${command} ETIMEDOUT`) : null),
      });
    });
  });
}

function listWindowsProcesses() {
  if (process.platform !== "win32") return [];
  const result = spawnSync("powershell.exe", [
    "-NoProfile",
    "-Command",
    "Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress -Depth 3",
  ], { encoding: "utf8", windowsHide: true, timeout: 10000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  if (!result.stdout.trim()) return [];
  const parsed = JSON.parse(result.stdout);
  return Array.isArray(parsed) ? parsed : [parsed];
}

test("Antigravity idle lock reap is allowed while later requests are queued", () => {
  const server = readFileSync(resolve(root, "translator", "adaptive-server.mjs"), "utf8");
  assert.match(server, /function releaseIdleAntigravitySessionLockIfSafe/);
  assert.match(server, /ANTIGRAVITY_QUEUED_IDLE_SESSION_RELEASE_MS/);
  assert.match(server, /ANTIGRAVITY_STREAM_IDLE_TIMEOUT_MS/);
  assert.match(server, /ANTIGRAVITY_STREAM_TOTAL_TIMEOUT_MS/);
  assert.match(server, /refreshStreamIdleTimeout/);
  assert.match(server, /Anti-Codex Antigravity stream produced no events/);
  assert.match(server, /antigravity_stream_total_timeout/);
  assert.match(server, /streamIdleTimedOut/);
  assert.match(server, /antigravity_stream_idle_timeout/);
  assert.match(server, /Promise\.race\(\[upstreamRun,\s*streamIdleWait\]\)/);
  assert.match(server, /releaseIdleActive/);
  assert.match(server, /Number\(lock\.queued\s*\|\|\s*0\)\s*>\s*0/);
  assert.match(server, /pendingNewSession = options\?\.pendingNewSession === true/);
  assert.match(server, /Number\(lock\.queued \|\| 0\) > 0 \|\| pendingNewSession/);
  assert.match(server, /pendingNewAntigravitySession/);
  assert.match(server, /toolOutputCallIdsFromRequest\(parsed\)\.length === 0/);
  assert.match(server, /Math\.min\(ANTIGRAVITY_IDLE_SESSION_RELEASE_MS,\s*ANTIGRAVITY_QUEUED_IDLE_SESSION_RELEASE_MS\)/);
  assert.doesNotMatch(
    server,
    /Number\(queue\.queued\s*\|\|\s*0\)\s*!==\s*0/,
    "queued follow-up requests must not prevent stale tool-continuation lock cleanup",
  );
  assert.match(server, /attachAntigravityStreamingClientAbort/);
  assert.match(server, /res\.on\?\.\("close", abortStreaming\)/);
});

test("translator ignores benign local connection resets instead of exiting", () => {
  const server = readFileSync(resolve(root, "translator", "adaptive-server.mjs"), "utf8");

  assert.match(server, /function isBenignLocalConnectionError/);
  assert.match(server, /ECONNRESET/);
  assert.match(server, /connection_reset_ignored/);
  assert.match(server, /server\.on\("clientError"/);
  assert.doesNotMatch(server, /if \(isBenignLocalConnectionError\(error\)\)[\s\S]{0,240}process\.exit\(1\)/);
});

test("Antigravity system prompt requires local artifact verification before completion", () => {
  const server = readFileSync(resolve(root, "translator", "adaptive-server.mjs"), "utf8");

  assert.match(server, /Local artifact completion rule/);
  assert.match(server, /preserve exact user-provided strings, markers, file names, and paths byte-for-byte/);
  assert.match(server, /treat them as a checklist/);
  assert.match(server, /explicitly says to create one required file first/);
  assert.match(server, /run a follow-up read\/check command before claiming completion/);
  assert.match(server, /Verify required files exist and required exact marker strings and feature keywords are present/);
  assert.match(server, /Do not reply with \\"completed\\" merely because a write command exited successfully/);
  assert.match(server, /Passing code tests does not complete a task while any explicitly required file or deliverable is still missing/);
  assert.match(server, /Do not call get_goal for an ordinary file or coding task/);
  assert.match(server, /use shell\/PowerShell file writes instead of apply_patch/);
  assert.match(server, /Do not use apply_patch for fixture\/temp\/example\/generated directory tasks/);
  assert.match(server, /use shell\/PowerShell file writing inside that scoped directory/);
  assert.match(server, /Do not inspect unrelated assistant history, Antigravity brain, transcript, or log folders/);
});

test("Antigravity routes explicit desktop web searches through stable internal search", () => {
  const server = readFileSync(resolve(root, "translator", "adaptive-server.mjs"), "utf8");

  assert.match(server, /shouldUseDeterministicInternalWebSearchResponse\(parsed\)/);
  assert.match(server, /preferredInternalWebToolName\(request\) === "web_search"/);
  assert.match(server, /deterministicInternalWebSearchResponse\(parsed,\s*chatBody,\s*routing\)/);
  assert.match(server, /deterministicInternalWebSearchChatCompletion\(parsed,\s*chatBody\)/);
  assert.match(server, /已完成联网搜索。下面是基于搜索结果整理的简要回答/);
  assert.match(server, /if \(directSearch\) \{\s*lines\.length = 0;/);
});

test("Anti-Codex launcher defaults UI task threads to full access", () => {
  const launcher = readFileSync(resolve(root, "scripts", "start-deepcodex.ps1"), "utf8");
  assert.match(launcher, /state\["permissions-mode"\]\s*=\s*"full-access"/);
  assert.match(launcher, /atom\["permissions-mode"\]\s*=\s*"full-access"/);
  assert.match(launcher, /atom\["agent-mode-by-host-id"\]\.local\s*=\s*"full-access"/);
  assert.match(launcher, /activePermissionProfile:\s*\{\s*id:\s*":danger-full-access"/);
  assert.match(launcher, /approvalPolicy:\s*"never"/);
  assert.match(launcher, /type:\s*"dangerFullAccess"/);
  assert.doesNotMatch(launcher, /networkAccess:\s*false/);
});

test("Anti-Codex launcher selects isolated Antigravity mode", () => {
  const launcher = readFileSync(resolve(root, "scripts", "start-anticodex.ps1"), "utf8");
  const server = readFileSync(resolve(root, "translator", "adaptive-server.mjs"), "utf8");

  assert.match(launcher, /TRANSLATOR_UPSTREAM_MODE\s*=\s*["']antigravity["']/i);
  assert.match(launcher, /ANTICODEX_ANTIGRAVITY_TRANSPORT\s*=\s*["']cli["']/i);
  assert.match(launcher, /ANTICODEX_ANTIGRAVITY_CLI_PROFILE_ROOT/);
  assert.match(launcher, /antigravity-cli-profile/);
  assert.match(launcher, /Set-AntiCodexAntigravityCliEnvironment/);
  assert.match(launcher, /ANTICODEX_ANTIGRAVITY_CLI_ISOLATE_WINDOWS_APPDATA/);
  assert.match(launcher, /strictWindowsAppDataIsolation/);
  assert.match(launcher, /ANTICODEX_NATIVE_TOOL_BRIDGE\s*=\s*["']0["']/i);
  assert.match(launcher, /anticodex-launcher\.out\.log/);
  assert.match(launcher, /anticodex-launcher\.err\.log/);
  assert.match(launcher, /RedirectStandardOutput/);
  assert.match(launcher, /RedirectStandardError/);
  assert.match(launcher, /function Find-AntiCodexLocalAddress/);
  assert.match(launcher, /return "127\.0\.0\.1"/);
  assert.match(launcher, /TRANSLATOR_LISTEN_HOST\s*=\s*"127\.0\.0\.1"/);
  assert.match(launcher, /TRANSLATOR_HOST\s*=\s*"127\.0\.0\.1"/);
  assert.match(launcher, /TRANSLATOR_URL\s*=\s*"http:\/\/\$\(\$env:TRANSLATOR_HOST\):\$\(\$env:TRANSLATOR_PORT\)"/);
  assert.doesNotMatch(launcher, /Get-NetIPAddress/);
  assert.match(launcher, /TRANSLATOR_HOST/);
  assert.match(launcher, /TRANSLATOR_URL/);
  assert.match(launcher, /function Get-RunningAntiCodexMain/);
  assert.match(launcher, /\$runningMain = Get-RunningAntiCodexMain -MainExecutable \$mainExecutable/);
  assert.match(launcher, /\$translatorLoopbackUrl = "http:\/\/127\.0\.0\.1:\$\(\$env:TRANSLATOR_PORT\)"/);
  assert.match(launcher, /Test-AntiCodexTranslatorHealth \$translatorLoopbackUrl/);
  assert.match(launcher, /profile\.transport/);
  assert.match(launcher, /function Test-AntiCodexRequiresAntigravityDesktop/);
  assert.match(launcher, /Antigravity CLI model text transport; Antigravity Desktop is not required/);
  assert.match(server, /modelTextTransport/);
  assert.match(server, /process\.env\.ANTICODEX_ANTIGRAVITY_TRANSPORT \|\| "cli"/);
  assert.match(server, /function antigravityModelDiscoverySource/);
  assert.match(server, /antigravity-cli-catalog/);
  assert.match(server, /modelDiscoverySource:\s*antigravityMode \? antigravityModelDiscoverySource\(modelTextTransport\) : "upstream-profile"/);
  assert.match(server, /antigravityCoworkerDefault:\s*false/);
  assert.match(server, /模型传输/);
  assert.match(server, /模型发现/);
  assert.match(launcher, /expectedTransport/);
  assert.match(launcher, /DEEPCODEX_STATE_ROOT/);
  assert.match(launcher, /function Resolve-AntiCodexInstallRoot/);
  assert.doesNotMatch(launcher, /Split-Path -Leaf \$scriptParent\) -ieq "runtime"/);
  assert.match(launcher, /CODEX_HOME_DIR\s*=\s*Join-Path \$env:DEEPCODEX_STATE_ROOT "codex-home-deepseek-app"/);
  assert.match(launcher, /CODEX_HOME\s*=\s*\$env:CODEX_HOME_DIR/);
  assert.match(launcher, /GLOBAL_CODEX_HOME\s*=\s*Join-Path \$env:USERPROFILE ".codex"/);
  assert.match(launcher, /DEEPCODEX_SHARED_CODEX_HOME\s*=\s*\$env:GLOBAL_CODEX_HOME/);
  assert.match(launcher, /DEEPCODEX_DISABLE_GPU\s*=\s*["']1["']/);
  assert.match(launcher, /start-deepcodex\.ps1/i);
  assert.match(launcher, /AppActivate/);
  assert.match(launcher, /Test-AntiCodexTranslatorHealth/);
  assert.doesNotMatch(launcher, /TRANSLATOR_LISTEN_HOST\s*=\s*["']0\.0\.0\.0["']/);
  assert.match(launcher, /ANTICODEX_TRANSLATOR_HEALTH_TIMEOUT_MS/);
  assert.match(launcher, /\$env:ANTICODEX_TRANSLATOR_HEALTH_TIMEOUT_MS/);
  assert.match(launcher, /\$ANTICODEX_TRANSLATOR_HEALTH_TIMEOUT_MS[\s\S]*else \{ 8000 \}/);
  assert.doesNotMatch(launcher, /request\.Timeout\s*=\s*2000/);
  assert.ok(
    launcher.indexOf("$runningMain = Get-RunningAntiCodexMain") < launcher.indexOf("$updateChecker = Join-Path"),
    "running Anti-Codex fast path should run before update checks",
  );
  assert.ok(
    launcher.indexOf("$runningMain = Get-RunningAntiCodexMain") < launcher.indexOf("$antigravityDesktopHelper = Join-Path"),
    "running Anti-Codex fast path should not load Antigravity helper first",
  );
});

test("Anti-Codex conversation cleanup preserves project roots and native Codex isolation", () => {
  const cleanup = readFileSync(resolve(root, "scripts", "clear-anticodex-conversations.ps1"), "utf8");

  assert.match(cleanup, /conversation-backups/);
  assert.match(cleanup, /state_5\.sqlite/);
  assert.match(cleanup, /state_5\.sqlite-wal/);
  assert.match(cleanup, /state_5\.sqlite-shm/);
  assert.match(cleanup, /sqlite\\codex-dev\.db/);
  assert.match(cleanup, /response-history\.json/);
  assert.match(cleanup, /sessions/);
  assert.match(cleanup, /codex-home-deepseek-app/);
  assert.match(cleanup, /codexHomeFull/);
  assert.match(cleanup, /codexHomeFull "sessions"/);
  assert.match(cleanup, /codexHomeFull "state_5\.sqlite"/);
  assert.match(cleanup, /codexHomeFull "sqlite\\codex-dev\.db"/);
  assert.match(cleanup, /codexHomeElectronDefault/);
  assert.match(cleanup, /codexGlobalStatePath/);
  assert.match(cleanup, /logs_2\.sqlite/);
  assert.match(cleanup, /electron-user-data-adaptive\\Default/);
  assert.match(cleanup, /Local Storage/);
  assert.match(cleanup, /Session Storage/);
  assert.match(cleanup, /History-journal/);
  assert.match(cleanup, /electron-saved-workspace-roots/);
  assert.match(cleanup, /active-workspace-roots/);
  assert.match(cleanup, /electron-workspace-root-labels/);
  assert.match(cleanup, /project-order/);
  assert.match(cleanup, /thread-client-id-v1/);
  assert.match(cleanup, /unread-thread-ids-by-host-v1/);
  assert.match(cleanup, /heartbeat-thread-permissions-by-id/);
  assert.match(cleanup, /projectless-thread-ids/);
  assert.match(cleanup, /prompt-history/);
  assert.match(cleanup, /composer-drafts/);
  assert.match(cleanup, /G:\\Trae-Project\\Anti-Codex\\deepcodex/);
  assert.match(cleanup, /\$workspaceLabel = "Anti-Codex"/);
  assert.match(cleanup, /\[string\]\$workspaceRootLabels\.\$workspaceRootFull -ieq "deepcodex"/);
  assert.match(cleanup, /Stop-Process/);
  assert.match(cleanup, /Get-AntiCodexProcesses/);
  assert.match(cleanup, /wouldStopProcessCount/);
  assert.match(cleanup, /if \(-not \$WhatIfOnly\) \{\s*Stop-ProcessList \$stopTargets/);
  assert.match(cleanup, /AppData\\Roaming\\anticodex/);
  assert.match(cleanup, /AppData\\Local\\Anti-Codex/);
  assert.match(cleanup, /Get-OriginalCodexMainProcesses/);
  assert.match(cleanup, /refusing to stop original Codex process ids/);
  assert.match(cleanup, /Assert-UnderPath/);
  assert.match(cleanup, /Move-IfExists/);
  assert.match(cleanup, /\[System\.IO\.Directory\]::Move/);
  assert.match(cleanup, /\[System\.IO\.File\]::Move/);
  assert.match(cleanup, /ConvertTo-Array/);
  assert.match(cleanup, /electron-persisted-atom-state/);
  assert.match(cleanup, /agent-mode-by-host-id/);
  assert.match(cleanup, /skip-full-access-confirm/);
  assert.match(cleanup, /composer-permission-mode-visibility/);
  assert.match(cleanup, /full-access/);
  assert.match(cleanup, /thread-client-id-v1:\*/);
  assert.match(cleanup, /refusing non-default Anti-Codex state root/);
  assert.match(cleanup, /protect-anticodex-log-db\.mjs/);
  assert.doesNotMatch(cleanup, /Remove-Item\s+[^`r`n]*(?:USERPROFILE|\\\.codex|AppData\\Roaming\\Codex|AppData\\Local\\Codex)/i);
  assert.doesNotMatch(cleanup, /Move-Item\s+[^`r`n]*(?:USERPROFILE|\\\.codex|AppData\\Roaming\\Codex|AppData\\Local\\Codex)/i);
});

test("Anti-Codex recovers a dead translator without restarting its desktop window", () => {
  const launcher = readFileSync(resolve(root, "scripts", "start-anticodex.ps1"), "utf8");
  const sharedLauncher = readFileSync(resolve(root, "scripts", "start-deepcodex.ps1"), "utf8");
  const runningMainBranch = launcher.match(/if \(\$runningMain\) \{[\s\S]*?\n\}/)?.[0];

  assert.ok(runningMainBranch, "missing running Anti-Codex recovery branch");
  assert.match(runningMainBranch, /start-deepcodex\.ps1/);
  assert.match(runningMainBranch, /-TranslatorOnly/);
  assert.match(runningMainBranch, /Activate-AntiCodexWindow/);
  assert.doesNotMatch(runningMainBranch, /Stop-Process|StartsWith\(\$installRoot/);
  assert.match(sharedLauncher, /param\s*\(\s*\[switch\]\$TranslatorOnly\s*\)/);
  assert.match(sharedLauncher, /translator-only start found restart lock; waiting for existing restart owner/);
  assert.match(sharedLauncher, /ANTICODEX_TRANSLATOR_RESTART_LOCK_OWNER/);
});

test("shared launcher watchdog restores translator while the desktop window is open", () => {
  const sharedLauncher = readFileSync(resolve(root, "scripts", "start-deepcodex.ps1"), "utf8");
  const monitorLoop = sharedLauncher.match(/while \(-not \$codexProc\.HasExited\) \{[\s\S]*?\n    \}/)?.[0];

  assert.match(sharedLauncher, /\$env:CODEX_HOME_DIR\s*=\s*\$CODEX_HOME_DIR/);
  assert.match(sharedLauncher, /\$env:CODEX_HOME\s*=\s*\$CODEX_HOME_DIR/);
  assert.match(sharedLauncher, /\$env:GLOBAL_CODEX_HOME\s*=\s*\$GLOBAL_CODEX_HOME/);
  assert.match(sharedLauncher, /\$env:DEEPCODEX_SHARED_CODEX_HOME\s*=\s*\$GLOBAL_CODEX_HOME/);
  assert.match(sharedLauncher, /function Ensure-TranslatorRunning/);
  assert.ok(monitorLoop, "missing desktop lifetime monitor loop");
  assert.match(monitorLoop, /Ensure-TranslatorRunning/);
  assert.match(monitorLoop, /\$translatorRecoveryCooldownUntil/);
  assert.match(monitorLoop, /AddSeconds\(30\)/);
  assert.match(sharedLauncher, /Translator watchdog restart failed; retrying after 30-second cooldown/);
  assert.match(sharedLauncher, /Test-TranslatorHealth/);
  assert.match(sharedLauncher, /Start-TranslatorProcess/);
  assert.match(sharedLauncher, /translator health lost; restarting/i);
});

test("translator watchdog tolerates transient health stalls before restarting", () => {
  const sharedLauncher = readFileSync(resolve(root, "scripts", "start-deepcodex.ps1"), "utf8");
  const ensureFunction = sharedLauncher.match(/function Ensure-TranslatorRunning \{[\s\S]*?\n\}/)?.[0];

  assert.match(sharedLauncher, /TRANSLATOR_HEALTH_TIMEOUT_MS/);
  assert.match(sharedLauncher, /TRANSLATOR_LISTEN_HOST[\s\S]*"127\.0\.0\.1"/);
  assert.doesNotMatch(sharedLauncher, /TRANSLATOR_LISTEN_HOST[\s\S]{0,80}"0\.0\.0\.0"/);
  assert.match(sharedLauncher, /TRANSLATOR_HEALTH_FAILURE_THRESHOLD/);
  assert.match(sharedLauncher, /function Test-TranslatorHealthWithGrace/);
  assert.match(sharedLauncher, /ANTICODEX_TRANSLATOR_BUSY_PATH/);
  assert.match(sharedLauncher, /ANTICODEX_TRANSLATOR_BUSY_HEALTH_GRACE_SECONDS/);
  assert.match(sharedLauncher, /ANTICODEX_TRANSLATOR_RESTART_LOCK_PATH/);
  assert.match(sharedLauncher, /ANTICODEX_TRANSLATOR_RESTART_LOCK_MAX_AGE_SECONDS/);
  assert.match(
    sharedLauncher,
    /\$ANTICODEX_TRANSLATOR_BUSY_HEALTH_GRACE_SECONDS[\s\S]*else \{ 900 \}/,
    "desktop real-traffic requests must not be killed by the watchdog after a 30-second health stall",
  );
  assert.match(sharedLauncher, /function Test-TranslatorBusyMarker/);
  assert.match(sharedLauncher, /function Test-TranslatorBusyRestartGraceActive/);
  assert.match(sharedLauncher, /function Test-TranslatorRestartLockActive/);
  assert.match(sharedLauncher, /function Wait-TranslatorRestartLockOwnerHealth/);
  assert.match(sharedLauncher, /function Test-TranslatorDiagnosticsBusy/);
  assert.match(sharedLauncher, /\/anticodex\/diagnostics/);
  assert.match(sharedLauncher, /activeAntigravityRequests\.active/);
  assert.match(sharedLauncher, /antigravityQueue\.running/);
  assert.match(sharedLauncher, /antigravitySessionLock\.queued/);
  assert.ok(ensureFunction, "missing translator watchdog function");
  assert.match(ensureFunction, /Test-TranslatorHealthWithGrace/);
  assert.ok(
    ensureFunction.indexOf("Test-TranslatorRestartLockActive") < ensureFunction.indexOf("translator health lost; restarting"),
    "watchdog must check a sync restart lock before restarting",
  );
  assert.ok(
    ensureFunction.indexOf("Test-TranslatorBusyMarker") < ensureFunction.indexOf("translator health lost; restarting"),
    "watchdog must evaluate busy state before restarting",
  );
  assert.ok(
    ensureFunction.indexOf("Test-TranslatorDiagnosticsBusy") < ensureFunction.indexOf("translator health lost; restarting"),
    "watchdog must evaluate diagnostics busy state before restarting",
  );
  assert.ok(
    ensureFunction.indexOf("Test-TranslatorBusyMarker") < ensureFunction.indexOf("Stop-StaleDeepCodexTranslator"),
    "busy marker check must happen before stopping translator processes",
  );
  assert.match(ensureFunction, /restart skipped within busy grace/i);
  assert.match(ensureFunction, /translator restart lock is active; waiting for restart owner health/i);
  assert.match(ensureFunction, /Wait-TranslatorRestartLockOwnerHealth 8/);
  assert.match(ensureFunction, /translator restart lock did not restore health; forcing restart/i);
  assert.match(ensureFunction, /Stop-StaleDeepCodexTranslator[\s\S]{0,160}Start-TranslatorProcess \$FallbackRuntimeBin/);
  assert.match(ensureFunction, /busy grace expired; forcing restart/i);
  assert.match(ensureFunction, /translator health lost; restarting/i);
});

test("Anti-Codex watchdog health URL follows the translator listen host", () => {
  const sharedLauncher = readFileSync(resolve(root, "scripts", "start-deepcodex.ps1"), "utf8");
  const endpointStart = sharedLauncher.indexOf("function Set-AntiCodexTranslatorEndpointDefaults");
  const endpointEnd = sharedLauncher.indexOf("\nSet-AntiCodexTranslatorEndpointDefaults", endpointStart);
  const endpointDefaults = endpointStart >= 0 && endpointEnd > endpointStart
    ? sharedLauncher.slice(endpointStart, endpointEnd)
    : "";

  assert.ok(endpointDefaults, "missing Anti-Codex endpoint default function");
  assert.match(sharedLauncher, /function Get-AntiCodexTranslatorGatewayHost/);
  assert.match(sharedLauncher, /function Test-AntiCodexTranslatorUrlMatchesListenHost/);
  assert.match(endpointDefaults, /TRANSLATOR_LISTEN_HOST\s*=\s*"127\.0\.0\.1"/);
  assert.match(endpointDefaults, /Get-AntiCodexTranslatorGatewayHost \$env:TRANSLATOR_LISTEN_HOST/);
  assert.match(endpointDefaults, /Test-AntiCodexTranslatorUrlMatchesListenHost \$env:TRANSLATOR_URL \$env:TRANSLATOR_LISTEN_HOST/);
  assert.doesNotMatch(
    endpointDefaults,
    /Find-AntiCodexLocalAddress[\s\S]{0,160}TRANSLATOR_URL/,
    "watchdog health must not use a LAN host while the translator listens on loopback",
  );
});

test("Anti-Codex startup installs a logs_2 sqlite TRACE write guard", () => {
  const sharedLauncher = readFileSync(resolve(root, "scripts", "start-deepcodex.ps1"), "utf8");
  const guardPath = resolve(root, "scripts", "protect-anticodex-log-db.mjs");

  assert.equal(existsSync(guardPath), true, "missing Anti-Codex log database guard script");

  const guard = readFileSync(guardPath, "utf8");
  assert.match(sharedLauncher, /PROTECT_ANTICODEX_LOG_DB/);
  assert.match(sharedLauncher, /function Protect-AntiCodexLogDb/);
  assert.match(sharedLauncher, /protect-anticodex-log-db\.mjs/);
  assert.match(sharedLauncher, /if \(-not \(Protect-AntiCodexLogDb\)\) \{/);
  assert.match(sharedLauncher, /Anti-Codex log database guard failed; refusing to continue startup/);
  assert.match(sharedLauncher, /\$env:RUST_LOG/);
  assert.match(sharedLauncher, /codex_app_server_transport::transport::remote_control::websocket=warn/);
  assert.match(guard, /anticodex_drop_trace_logs/);
  assert.match(guard, /WHEN NEW\.level = 'TRACE'/);
  assert.match(guard, /RAISE\(IGNORE\)/);
  assert.match(guard, /wal_checkpoint\(TRUNCATE\)/);
  assert.match(guard, /--self-test/);
  assert.match(guard, /--status/);
  assert.match(guard, /allow-any-codex-home/);
  assert.match(guard, /codex-home-deepseek-app/);
});

test("translator watchdog does not restart for Antigravity account or proxy readiness failures", () => {
  const sharedLauncher = readFileSync(resolve(root, "scripts", "start-deepcodex.ps1"), "utf8");
  const healthFunction = sharedLauncher.match(/function Test-TranslatorHealth \{[\s\S]*?\n\}/)?.[0];

  assert.ok(healthFunction, "missing translator health predicate");
  assert.match(healthFunction, /\$snapshot\s+-and\s+\$snapshot\.ok/);
  assert.doesNotMatch(healthFunction, /accountReady|accountState|antigravityCircuitState|antigravityCircuitRetryAfterMs/);
});

test("tool bridge verifier allows slow diagnostics during UI overall checks", () => {
  const verifier = readFileSync(resolve(root, "scripts", "test-anticodex-tool-bridge-mode.ps1"), "utf8");

  assert.match(verifier, /Min\(30,\s*\[Math\]::Min\(\$TimeoutSec/);
  assert.doesNotMatch(verifier, /Min\(8,\s*\[Math\]::Min\(\$TimeoutSec/);
});

test("shared launcher only restores Antigravity Desktop when transport requires it", () => {
  const sharedLauncher = readFileSync(resolve(root, "scripts", "start-deepcodex.ps1"), "utf8");
  const launcher = readFileSync(resolve(root, "scripts", "start-anticodex.ps1"), "utf8");
  const desktopHelper = readFileSync(resolve(root, "scripts", "antigravity-desktop.ps1"), "utf8");

  assert.match(sharedLauncher, /antigravity-desktop\.ps1/);
  assert.match(sharedLauncher, /function Test-AntiCodexRequiresAntigravityDesktop/);
  assert.match(sharedLauncher, /function Ensure-AntigravityDesktopRunning/);
  assert.match(sharedLauncher, /if \(-not \(Test-AntiCodexRequiresAntigravityDesktop\)\) \{ return \$true \}/);
  assert.match(sharedLauncher, /ANTIGRAVITY_RESTART_COOLDOWN_SECONDS/);
  assert.match(sharedLauncher, /antigravityRestartNotBefore/);
  assert.match(sharedLauncher, /Antigravity Desktop restart deferred until/i);
  assert.match(sharedLauncher, /Antigravity Desktop restart candidate exited before becoming stable/i);
  assert.match(sharedLauncher, /Antigravity Desktop process disappeared; restarting/i);
  assert.match(sharedLauncher, /ANTIGRAVITY_DESKTOP_PATH/);
  assert.match(sharedLauncher, /Ensure-AntigravityDesktopRunning/);
  assert.match(launcher, /antigravity-desktop\.ps1/);
  assert.match(launcher, /Test-AntiCodexRequiresAntigravityDesktop \$antiCodexUsesAntigravity/);
  assert.match(launcher, /Resolve-AntigravityDesktopPath/);
  assert.match(launcher, /Antigravity CLI model text transport; Antigravity Desktop is not required/);
  assert.match(desktopHelper, /function Resolve-AntigravityDesktopPath/);
  assert.match(desktopHelper, /function Get-AntigravityMainProcess/);
  assert.match(desktopHelper, /DisplayIcon/);
  assert.match(desktopHelper, /InstallLocation/);
  assert.match(desktopHelper, /Antigravity IDE\.exe/);
  assert.match(desktopHelper, /ExecutablePath/);
  assert.doesNotMatch(launcher, /Get-Process -Name "antigravity"/);
});

test("shared launcher skips DeepSeek key setup in Antigravity mode", () => {
  const launcher = readFileSync(resolve(root, "scripts", "start-deepcodex.ps1"), "utf8");

  assert.match(launcher, /IS_ANTIGRAVITY_MODE/);
  assert.match(launcher, /\$expectedAntiCodexRuntime = Join-Path \(Join-Path \$env:LOCALAPPDATA "Anti-Codex"\) "runtime"/);
  assert.match(launcher, /\[IO\.Path\]::GetFullPath\(\$ROOT\)/);
  assert.match(launcher, /Refusing to fall back to the original Codex executable/);
  assert.doesNotMatch(launcher, /Split-Path -Leaf \(Split-Path -Parent \$ROOT\)\) -ieq "Anti-Codex"/);
  assert.match(launcher, /TRANSLATOR_UPSTREAM_MODE\s*=\s*"antigravity"/);
  assert.match(launcher, /if\s*\(-not \$USES_ANTIGRAVITY_UPSTREAM -and -not \$UPSTREAM_API_KEY\)/);
  assert.match(launcher, /OPENAI_API_KEY:\s*localApiKey/);
  assert.match(launcher, /\$env:OPENAI_API_KEY\s*=\s*\$LOCAL_CODEX_API_KEY/);
  assert.match(launcher, /\$env:CODEX_API_KEY\s*=\s*\$LOCAL_CODEX_API_KEY/);
  assert.match(launcher, /\$env:TRANSLATOR_HOST\s*=\s*\$gatewayHost/);
  assert.match(launcher, /Test-AntiCodexTranslatorUrlMatchesListenHost/);
  assert.match(launcher, /TRANSLATOR_LISTEN_HOST/);
  assert.match(launcher, /\.Proxy\s*=\s*\$null/);
  assert.match(launcher, /responses_websockets/);
  assert.match(launcher, /responses_websockets_v2/);
});

test("Antigravity mode never writes ChatGPT account auth", () => {
  const launcher = readFileSync(resolve(root, "scripts", "start-deepcodex.ps1"), "utf8");
  const antigravityAuthBlock = launcher.match(/if \(isAntigravityMode === "True"\) \{[\s\S]*?process\.exit\(0\);\s*\}/)?.[0];

  assert.ok(antigravityAuthBlock, "missing Antigravity auth branch");
  assert.match(antigravityAuthBlock, /OPENAI_API_KEY:\s*localApiKey/);
  assert.doesNotMatch(antigravityAuthBlock, /auth_mode|chatgpt|tokens|refresh_token|auth\.openai|oauth/i);
  assert.match(launcher, /\["cli_auth_credentials_store",\s*tomlString\("file"\)\]/);
});

test("Anti-Codex shell blocks ChatGPT login UI routes", () => {
  const brander = readFileSync(resolve(root, "scripts", "brand-patched-asar.mjs"), "utf8");

  assert.match(brander, /authMethod:`apikey`,requiresAuth:!1/);
  assert.match(brander, /requiresAuth:!1/);
  assert.match(brander, /to:`\/login`,replace:!0/);
  assert.match(brander, /if\(!0\)\{/);
  assert.match(brander, /"auth-requirement"/);
  assert.match(brander, /"app-route-gate"/);
  assert.match(brander, /criticalPatchNames/);
});

test("Anti-Codex shell hides retry stream errors from chat", () => {
  const brander = readFileSync(resolve(root, "scripts", "brand-patched-asar.mjs"), "utf8");

  assert.match(brander, /function patchRetryStreamErrorVisibility/);
  assert.match(brander, /case`error`:if\(n\.willRetry\)\{break\}else if\(/);
  assert.match(brander, /findRetryStreamErrorVisibilityPatch/);
  assert.match(brander, /retry-stream-error-visibility/);
  assert.match(brander, /criticalPatchNames[\s\S]*retry-stream-error-visibility/);
});

test("plugin UI unlock is guarded as an unsafe debug-only path", () => {
  const launcher = readFileSync(resolve(root, "scripts", "start-deepcodex.ps1"), "utf8");
  const unlockHelper = readFileSync(resolve(root, "scripts", "enable-deepcodex-plugin-unlock.ps1"), "utf8");

  assert.match(launcher, /ANTICODEX_UNSAFE_PLUGIN_UNLOCK/);
  assert.match(launcher, /\$DEEPCODEX_PLUGIN_UNLOCK_ENABLED = \(\$DEEPCODEX_PLUGIN_UNLOCK -ne "0"\) -and \$ANTICODEX_UNSAFE_PLUGIN_UNLOCK/);
  assert.match(launcher, /\$needPluginUnlockInject = \$DEEPCODEX_PLUGIN_UNLOCK_ENABLED/);
  assert.doesNotMatch(launcher, /\$needPluginUnlockInject = \(\$DEEPCODEX_PLUGIN_UNLOCK -ne "0"\)/);
  assert.match(unlockHelper, /ANTICODEX_UNSAFE_PLUGIN_UNLOCK -ne "1"/);
  assert.match(unlockHelper, /unsafe debug-only path/);
});

test("Anti-Codex shell exposes a visible in-app manager entry", () => {
  const brander = readFileSync(resolve(root, "scripts", "brand-patched-asar.mjs"), "utf8");
  const launcher = readFileSync(resolve(root, "scripts", "start-deepcodex.ps1"), "utf8");
  const cdpInject = readFileSync(resolve(root, "scripts", "deepcodex-cdp-inject.mjs"), "utf8");
  const managerInject = readFileSync(resolve(root, "scripts", "anticodex-manager-inject.js"), "utf8");
  const managerOpenInject = readFileSync(resolve(root, "scripts", "anticodex-manager-open-inject.js"), "utf8");
  const managerBridge = readFileSync(resolve(root, "scripts", "anticodex-manager-bridge.mjs"), "utf8");
  const managerServerSource = readFileSync(resolve(root, "translator", "adaptive-server.mjs"), "utf8");
  const syncReadiness = readFileSync(resolve(root, "scripts", "test-anticodex-sync-readiness.ps1"), "utf8");
  const uiState = readFileSync(resolve(root, "scripts", "test-anticodex-ui-state.mjs"), "utf8");
  const repairShortcuts = readFileSync(resolve(root, "scripts", "repair-anticodex-shortcuts.ps1"), "utf8");

  assert.match(brander, /anticodex-manager/);
  assert.match(brander, /Anti-Codex \\\\u7ba1\\\\u7406/);
  assert.match(brander, /__ANTICODEX_OPEN_MANAGER__/);
  assert.match(brander, /"profile-dropdown-settings"/);
  assert.doesNotMatch(brander, /anticodex\/manager\/open/);
  assert.doesNotMatch(brander, /globalThis\.location\.assign\(`http:\/\/127\.0\.0\.1:8484\/anticodex\/manager`\)/);
  assert.match(brander, /codex\.profileDropdown\.settingsPage/);
  assert.match(brander, /if \(next\.includes\("anticodex-manager"\) && next\.includes\("__ANTICODEX_OPEN_MANAGER__"\)\) return next/);
  assert.match(brander, /next\.includes\("codex\.profileDropdown\.settingsPage"\)/);
  assert.match(launcher, /anticodex-manager-inject\.js/);
  assert.match(launcher, /anticodex-manager-bridge\.mjs/);
  assert.match(launcher, /ANTICODEX_MANAGER_CDP_LOG/);
  assert.match(launcher, /ANTICODEX_MANAGER_BRIDGE_LOG/);
  assert.match(launcher, /function Start-AntiCodexManagerBridge/);
  assert.match(launcher, /function Ensure-AntiCodexManagerBridgeRunning/);
  assert.match(launcher, /DEEPCODEX_CDP_MANAGER_WATCH = "1"/);
  assert.match(launcher, /"--watch"/);
  assert.match(launcher, /function Get-AntiCodexManagerInjectionWatchers/);
  assert.match(launcher, /function Reuse-AntiCodexManagerInjectionWatcher/);
  assert.match(launcher, /Reusing manager injection watcher/);
  assert.match(launcher, /stopping duplicate manager injection watcher/);
  assert.match(launcher, /Manager injection watcher disappeared; restarting/);
  assert.match(launcher, /function Wait-AntiCodexChildProcess/);
  assert.match(launcher, /\$Process\.HasExited/);
  assert.doesNotMatch(launcher, /WaitForExit\(3000\)/);
  assert.doesNotMatch(launcher, /WaitForExit\(8000\)/);
  assert.doesNotMatch(launcher, /WaitForExit\(2000\)/);
  assert.match(launcher, /managerInjectionOutput/);
  assert.match(launcher, /managerInjectionOutput -match '"ok"\\s\*:\\s\*true'/);
  assert.match(launcher, /Manager injection watcher is running/);
  assert.match(launcher, /Manager injection timed out after 3000ms/);
  assert.doesNotMatch(launcher, /WaitForExit\(8000\)[\s\S]{0,900}Manager injection/);
  assert.match(launcher, /function New-LaunchStageTimer/);
  assert.match(launcher, /function Write-LaunchStage/);
  assert.match(launcher, /launch stage:/);
  assert.match(launcher, /Manager bridge watchdog restart failed; retrying after 30-second cooldown/);
  assert.match(launcher, /--no-sandbox/);
  assert.match(launcher, /Refusing to fall back to the original Codex executable/);
  assert.match(launcher, /if \(\$IS_ANTICODEX_INSTALL_ROOT\) \{/);
  assert.match(launcher, /\$codexWorkingDirectory = Split-Path -Parent \$CODEX_BIN/);
  assert.match(launcher, /-WorkingDirectory \$codexWorkingDirectory/);
  assert.match(cdpInject, /DEEPCODEX_CDP_STABLE_PASSES \|\| 1/);
  assert.match(cdpInject, /managerWatchMode/);
  assert.match(cdpInject, /process\.env\.DEEPCODEX_CDP_MANAGER_WATCH === "1"/);
  assert.match(cdpInject, /process\.argv\.includes\("--watch"\)/);
  assert.match(cdpInject, /DEEPCODEX_CDP_MANAGER_DISCONNECT_MS/);
  assert.match(cdpInject, /managerDisconnectedSince/);
  assert.match(cdpInject, /manager watcher disconnected timeout/);
  assert.doesNotMatch(cdpInject, /DEEPCODEX_CDP_MANAGER_WATCH !== "0"/);
  assert.match(cdpInject, /waitForClose/);
  assert.match(cdpInject, /watching: true/);
  assert.match(cdpInject, /const newDocumentSource/);
  assert.match(cdpInject, /DOMContentLoaded/);
  assert.match(cdpInject, /managerHeartbeatMs/);
  assert.match(cdpInject, /maintainManager/);
  assert.match(cdpInject, /consecutiveFailures/);
  assert.match(cdpInject, /findDefaultContextId/);
  assert.match(cdpInject, /findDefaultContextIds/);
  assert.match(cdpInject, /pickVisiblePageContextId/);
  assert.match(cdpInject, /No default page execution context found for CDP injection/);
  assert.match(cdpInject, /contextId/);
  assert.match(cdpInject, /const loopbackManagerApi = `http:\/\/127\.0\.0\.1:\$\{managerPort\}`/);
  assert.match(cdpInject, /const candidates = \[\s*loopbackManagerApi,\s*managerApi,/);
  assert.doesNotMatch(cdpInject, /document\.getElementById\("anticodex-manager-overlay"\)\?\.remove\(\);/);
  assert.match(managerInject, /window\.__ANTICODEX_OPEN_MANAGER__/);
  assert.match(managerInject, /window\.__ANTICODEX_MANAGER_API__/);
  assert.match(managerInject, /apiCandidates/);
  assert.match(managerInject, /anticodex-manager-overlay/);
  assert.match(managerInject, /data-anticodex-close/);
  assert.match(managerInject, /\.anticodex-close\{[^}]*border:1px solid var\(--ac-line\)[^}]*background:var\(--ac-raised\)/);
  assert.doesNotMatch(managerInject, /\.anticodex-close::before/);
  assert.match(managerInject, /LEGACY_BUTTON_ID = "anticodex-manager-button"/);
  assert.match(managerInject, /document\.getElementById\(LEGACY_BUTTON_ID\)\?\.remove\(\)/);
  assert.doesNotMatch(managerInject, /document\.createElement\("button"\)/);
  assert.match(managerInject, /installManagerRuntime/);
  assert.match(managerInject, /refreshManagerStatus/);
  assert.match(managerInject, /anticodex-panel/);
  assert.match(managerInject, /\/anticodex\/manager\/bootstrap/);
  assert.match(managerInject, /\/anticodex\/manager\/action/);
  assert.match(managerInject, /__ANTICODEX_RUN_MANAGER_ACTION__/);
  assert.match(managerInject, /runActionViaBridge/);
  assert.match(managerInject, /runActionViaScript/);
  assert.match(managerInject, /refreshFeatures/);
  assert.match(managerInject, /fastOverallNoTraffic/);
  assert.match(managerInject, /accountSwitch/);
  assert.match(managerInject, /\\u5207\\u6362 Antigravity \\u8d26\\u53f7/);
  assert.match(managerInject, /ACCOUNT_SWITCH_POLL_INTERVAL_MS = 3000/);
  assert.match(managerInject, /ACCOUNT_SWITCH_TIMEOUT_MS = 120000/);
  assert.match(managerInject, /function modelCatalogFingerprint/);
  assert.match(managerInject, /async function captureAccountSwitchState/);
  assert.match(managerInject, /function accountSwitchChanged/);
  assert.match(managerInject, /async function waitForAccountSwitch/);
  assert.match(managerInject, /let accountSwitchObservationGeneration = 0/);
  assert.match(managerInject, /function cancelAccountSwitchObservation/);
  assert.match(managerInject, /reason:\s*"cancelled"/);
  assert.match(managerInject, /pending:\s*true/);
  assert.match(managerInject, /__ANTICODEX_MANAGER_PENDING_ACTIONS__/);
  assert.match(managerInject, /function pendingActionMaxMs/);
  assert.match(managerInject, /function actionStillPending/);
  assert.match(managerInject, /querySelector\(`#\$\{MANAGER_ID\} \[data-anticodex-result="action"\]`\)/);
  assert.match(managerInject, /result\.isConnected/);
  assert.match(managerInject, /__ANTICODEX_REFRESH_MANAGER_PANEL__\?\.\(\)/);
  assert.match(managerInject, /__ANTICODEX_MANAGER_SUPPRESS_REFRESH_STATUS_RESULT__/);
  assert.match(managerBridge, /suppressRefreshStatusResult/);
  assert.match(managerInject, /function removeManager\(\)[\s\S]*cancelAccountSwitchObservation\(\)/);
  assert.match(managerInject, /await runActionViaBridge\("refreshModels"\)/);
  assert.match(managerInject, /\\u81ea\\u52a8\\u68c0\\u6d4b\\u8d26\\u53f7\\u6216\\u6a21\\u578b\\u53d8\\u5316/);
  assert.match(managerInject, /\\u672a\\u68c0\\u6d4b\\u5230\\u53ef\\u8bc1\\u660e\\u7684\\u8d26\\u53f7\\u6216\\u6a21\\u578b\\u53d8\\u5316/);
  assert.match(managerInject, /Skill \\u6307\\u4ee4/);
  assert.match(managerInject, /MCP \\u914d\\u7f6e/);
  assert.match(managerInject, /\\u5f53\\u524d\\u53ef\\u8c03\\u7528\\u4ee5\\u672c\\u4f1a\\u8bdd\\u5de5\\u5177\\u5217\\u8868\\u4e3a\\u51c6/);
  assert.match(managerInject, /\\u5143\\u6570\\u636e\\u53ef\\u89c1 \/ \\u4e0d\\u7b49\\u4e8e\\u53ef\\u8c03\\u7528/);
  assert.match(managerInject, /\\u5feb\\u7167\\u65b0\\u9c9c\\u5ea6/);
  assert.match(managerInject, /\\u5237\\u65b0\\u672c\\u5730\\u529f\\u80fd/);
  assert.match(managerInject, /function formatReportAge/);
  assert.match(managerInject, /item\.stale/);
  assert.match(managerInject, /staleCount/);
  assert.match(managerInject, /item\.exists && item\.latestPath/);
  assert.match(managerInject, /\\u9700\\u91cd\\u8dd1/);
  assert.match(managerInject, /\\u8fd8\\u6ca1\\u6709\\u53ef\\u663e\\u793a\\u7684\\u9a8c\\u6536\\u62a5\\u544a/);
  assert.match(managerBridge, /function formatReportAge/);
  assert.match(managerBridge, /item\.stale/);
  assert.match(managerBridge, /staleCount/);
  assert.match(managerBridge, /item\.exists && item\.latestPath/);
  assert.match(managerBridge, /\\u9700\\u91cd\\u8dd1/);
  assert.match(managerBridge, /\\u8fd8\\u6ca1\\u6709\\u53ef\\u663e\\u793a\\u7684\\u9a8c\\u6536\\u62a5\\u544a/);
  assert.match(managerInject, /\\u8fdc\\u7a0b\\u8fde\\u63a5\\u5668\\u4ec5\\u76ee\\u5f55/);
  assert.match(managerInject, /Skill \\u662f\\u672c\\u5730\\u6307\\u4ee4\\uff1bMCP \\u5fc5\\u987b\\u7531\\u5f53\\u524d\\u4f1a\\u8bdd\\u771f\\u5b9e\\u66b4\\u9732\\u5de5\\u5177/);
  assert.doesNotMatch(managerInject, /\\u672c\\u5730\\u63d2\\u4ef6\/MCP \\u53ef\\u76f4\\u63a5\\u4f7f\\u7528/);
  assert.match(managerInject, /skipped: /);
  assert.match(managerInject, /requestedRealTraffic=/);
  assert.match(managerInject, /coverage=/);
  for (const source of [managerBridge, managerInject]) {
    assert.match(source, /modelRoutingEvidence/);
    assert.match(source, /modelRouting: mode=/);
    assert.match(source, /modelRouting route: protocol=/);
    assert.match(source, /modelThinkingEvidence/);
    assert.match(source, /modelThinking: models=/);
    assert.match(source, /uiIdleEvidence/);
    assert.match(source, /uiIdle: samples=/);
    assert.match(source, /syncReadinessEvidence/);
    assert.match(source, /syncReadiness: noTraffic=/);
    assert.match(source, /syncReadiness versions: codex=/);
    assert.match(source, /activeSource=/);
    assert.match(source, /versionMatch=/);
    assert.match(source, /syncReadiness hashes: host=/);
    assert.match(source, /updateStatusSource/);
    assert.match(source, /updateStatusReason/);
    assert.match(source, /managerBridgeProcessCount/);
    assert.match(source, /processes=/);
    assert.match(source, /installedOverallEvidence/);
    assert.match(source, /installedOverall: noTraffic=/);
    assert.match(source, /toolBridgeEvidence/);
    assert.match(source, /toolBridge: mode=/);
    assert.match(source, /toolBridge nativeMcp: envelope=/);
    assert.match(source, /externalToolDefinitionsField/);
    assert.match(source, /nativeMcpToolCallStatus/);
    assert.match(source, /accountProxyEvidence/);
    assert.match(source, /accountProxy: detail=/);
    assert.match(source, /accountProxy phase: account=/);
    assert.match(source, /accountProxy logs: source=/);
    assert.match(source, /managerButtonResults/);
    assert.match(source, /managerButtons: /);
    assert.match(source, /actionCenterHitsButton/);
    assert.match(source, /managerOpenedNewPage/);
  }
  assert.match(managerInject, /native-panel-v99/);
  assert.match(managerInject, /LOCAL_VERIFIER_ACTION_UI_TIMEOUT_MS = 190000/);
  assert.match(managerInject, /action === "mcpSkills" \|\| action === "pluginCapabilities"[\s\S]{0,80}LOCAL_VERIFIER_ACTION_UI_TIMEOUT_MS/);
  assert.match(syncReadiness, /native-panel-v99/);
  assert.match(uiState, /native-panel-v99/);
  assert.doesNotMatch(managerInject, /native-panel-v92/);
  assert.doesNotMatch(syncReadiness, /native-panel-v92/);
  assert.doesNotMatch(uiState, /native-panel-v92/);
  assert.doesNotMatch(managerInject, /native-panel-v91/);
  assert.doesNotMatch(syncReadiness, /native-panel-v91/);
  assert.doesNotMatch(uiState, /native-panel-v91/);
  assert.doesNotMatch(managerInject, /native-panel-v90/);
  assert.doesNotMatch(syncReadiness, /native-panel-v90/);
  assert.doesNotMatch(managerInject, /native-panel-v89/);
  assert.doesNotMatch(syncReadiness, /native-panel-v89/);
  assert.doesNotMatch(managerInject, /native-panel-v88/);
  assert.doesNotMatch(syncReadiness, /native-panel-v88/);
  assert.doesNotMatch(managerInject, /native-panel-v87/);
  assert.doesNotMatch(syncReadiness, /native-panel-v87/);
  assert.doesNotMatch(managerInject, /native-panel-v86/);
  assert.doesNotMatch(syncReadiness, /native-panel-v86/);
  assert.doesNotMatch(managerInject, /native-panel-v85/);
  assert.doesNotMatch(syncReadiness, /native-panel-v85/);
  assert.doesNotMatch(managerInject, /native-panel-v84/);
  assert.doesNotMatch(syncReadiness, /native-panel-v84/);
  assert.doesNotMatch(managerInject, /native-panel-v68/);
  assert.doesNotMatch(syncReadiness, /native-panel-v68/);
  assert.doesNotMatch(managerInject, /native-panel-v67/);
  assert.doesNotMatch(syncReadiness, /native-panel-v67/);
  assert.doesNotMatch(managerInject, /native-panel-v66/);
  assert.doesNotMatch(syncReadiness, /native-panel-v66/);
  assert.match(managerInject, /function updateOperationStateText/);
  assert.match(managerInject, /function syncReadinessEvidenceFromResult/);
  assert.match(managerInject, /function syncReadinessEvidenceLines/);
  assert.match(managerInject, /clientSyncMode/);
  assert.match(managerInject, /sync contract/);
  assert.match(managerInject, /noFeatureRebuild/);
  assert.match(managerInject, /updateStatus\.source\?\.packageVersion \|\| activeHost\.sourcePackageVersion/);
  assert.match(managerInject, /sourceHostHash/);
  assert.match(managerInject, /hostHashMatches/);
  assert.match(managerInject, /syncEvidence = diagnostics\?\.syncReadinessEvidence/);
  assert.match(managerInject, /Manager bridge/);
  assert.match(managerServerSource, /syncReadinessEvidence:\s*fast\s*\?\s*null\s*:\s*latestManagerReportItem/);
  assert.match(managerServerSource, /function syncReadinessEvidenceFromResult/);
  assert.match(managerServerSource, /syncReadinessEvidenceLines/);
  assert.match(managerServerSource, /clientSyncMode/);
  assert.match(managerServerSource, /sync contract/);
  assert.match(managerServerSource, /noFeatureRebuild/);
  assert.match(managerServerSource, /updateStatus\.source\?\.packageVersion\|\|activeHost\.sourcePackageVersion/);
  assert.match(managerServerSource, /sourceHostHash/);
  assert.match(managerServerSource, /hostHashMatches/);
  assert.match(managerServerSource, /sync drift/);
  assert.match(managerServerSource, /sync hashes/);
  assert.match(managerServerSource, /processes=/);
  assert.match(managerInject, /function updateOperationStageText/);
  assert.match(managerInject, /function updateStatusText/);
  assert.match(managerInject, /candidate_build/);
  assert.match(managerInject, /rollback_acceptance/);
  assert.match(managerInject, /operation\?\.message/);
  assert.doesNotMatch(syncReadiness, /native-panel-v65/);
  assert.doesNotMatch(syncReadiness, /native-panel-v64/);
  assert.doesNotMatch(syncReadiness, /native-panel-v63/);
  assert.doesNotMatch(syncReadiness, /native-panel-v62/);
  assert.doesNotMatch(syncReadiness, /native-panel-v61/);
  assert.doesNotMatch(syncReadiness, /native-panel-v60/);
  assert.doesNotMatch(syncReadiness, /native-panel-v59/);
  assert.doesNotMatch(syncReadiness, /native-panel-v58/);
  assert.doesNotMatch(syncReadiness, /native-panel-v57/);
  assert.doesNotMatch(syncReadiness, /native-panel-v56/);
  assert.match(managerInject, /thinking_budget/);
  assert.match(managerInject, /min_thinking_budget/);
  assert.match(managerInject, /\\u539f\\u751f\\u601d\\u8003\\u9884\\u7b97/);
  assert.match(managerInject, /preserveLastActionResult/);
  assert.match(managerInject, /lastActionResult\.ok !== false/);
  assert.match(managerInject, /BRIDGE_TIMEOUT_MS = 5000/);
  assert.match(managerInject, /EXTENDED_ACTION_UI_TIMEOUT_MS = 28000/);
  assert.match(managerInject, /if \(action === "updateCheck" \|\|[\s\S]{0,180}return EXTENDED_ACTION_UI_TIMEOUT_MS/);
  assert.match(managerInject, /actionUiTimeoutMs\(action\) \+ 1000/);
  assert.match(managerInject, /setActionButtonsDisabled/);
  assert.match(managerInject, /data-anticodex-busy/);
  assert.match(managerInject, /data-anticodex-running/);
  assert.match(managerInject, /const reset = r\.result \|\| r/);
  assert.match(managerInject, /if \(item\.exists && item\.latestPath\)/);
  assert.match(managerInject, /function formatReportAge/);
  assert.match(managerInject, /item\.exists && age/);
  assert.match(managerInject, /result\.staleCount/);
  assert.match(managerInject, /item\.stale \? "\\u9700\\u91cd\\u8dd1"/);
  assert.match(managerInject, /function actionProgressStage/);
  assert.match(managerInject, /setInterval\(\(\) =>/);
  assert.match(managerInject, /clearInterval\(progressTimer\)/);
  assert.match(managerInject, /\\u5df2\\u7528\\u65f6/);
  assert.match(managerInject, /\\u9636\\u6bb5/);
  assert.match(managerInject, /function reportSummaryLines/);
  assert.match(managerInject, /function failureSummaryLine/);
  assert.match(managerInject, /if \(action === "syncReadiness"\) return \[[\s\S]{0,220}failureSummaryLine\(r\)/);
  assert.match(managerInject, /\\u6700\\u65b0\\u62a5\\u544a/);
  assert.match(managerInject, /\\u5386\\u53f2\\u62a5\\u544a/);
  assert.match(managerInject, /\\u5931\\u8d25\\u9879/);
  assert.match(managerInject, /\/backend-api\/wham\/apps/);
  assert.match(managerInject, /safeJson\("\/backend-api\/wham\/apps"\)/);
  assert.match(managerInject, /connectorAllowlistEditor/);
  assert.match(managerInject, /\/anticodex\/local-connectors\/allowlist/);
  assert.match(managerInject, /anticodex-connector-allowlist-input/);
  assert.match(managerInject, /\\u4e0d\\u6388\\u6743/);
  assert.match(managerInject, /\\u4e0d\\u4ee3\\u8868\\u53ef\\u8c03\\u7528/);
  assert.match(managerInject, /x-anticodex-manager-token/);
  assert.match(managerInject, /function refreshManagerToken/);
  assert.match(managerInject, /function managerPostJson/);
  assert.match(managerInject, /error\?\.statusCode !== 403/);
  assert.match(managerInject, /window\.__ANTICODEX_MANAGER_SNAPSHOT__ = null/);
  assert.match(managerInject, /authorizedConnectorCount/);
  assert.match(managerInject, /\\u672a\\u6388\\u6743\\u8fde\\u63a5\\u5668\\u4e0d\\u4f2a\\u88c5\\u6210\\u53ef\\u8c03\\u7528\\u5de5\\u5177/);
  assert.match(managerInject, /function quotaLimitNotice/);
  assert.match(managerInject, /function refreshManagerStatus/);
  assert.match(managerInject, /const healthResult = await safeJson\("\/health"\)/);
  assert.match(managerInject, /if \(healthResult\.ok\) updateTrafficNotice\(health\)/);
  assert.match(managerInject, /__ANTICODEX_MANAGER_STATUS_TIMER__/);
  assert.match(managerInject, /if \(window\.__ANTICODEX_MANAGER_STATUS_TIMER__\)[\s\S]*clearInterval\(window\.__ANTICODEX_MANAGER_STATUS_TIMER__\)/);
  assert.match(managerInject, /setInterval\(refreshManagerStatus, 5000\)/);
  assert.match(managerInject, /refreshManagerStatus[\s\S]*__ANTICODEX_REFRESH_MANAGER_PANEL__/);
  assert.doesNotMatch(managerInject, /data-anticodex-update|BUTTON_TEXT/);
  assert.match(managerInject, /function installedCheckState/);
  assert.match(managerInject, /installedChecks/);
  assert.match(managerInject, /installed-overall-fast/);
  assert.match(managerInject, /\\u5feb\\u68c0\\u4e0d\\u4f1a\\u8986\\u76d6\\u5b8c\\u6574\\u603b\\u68c0\\u62a5\\u544a/);
  assert.match(managerInject, /quota_or_limit_reached/);
  assert.match(managerInject, /antigravity_quota_exceeded/);
  assert.match(managerInject, /accountTrafficSuggestedAction/);
  assert.match(managerInject, /anticodex-traffic-notice/);
  assert.match(managerInject, /function updateTrafficNotice/);
  assert.match(managerInject, /function trafficNoticeKey/);
  assert.match(managerInject, /function trafficNoticeSignature/);
  assert.match(managerInject, /accountTrafficLastFailureAt/);
  assert.match(managerInject, /__ANTICODEX_DISMISSED_TRAFFIC_NOTICE__/);
  assert.match(managerInject, /data-anticodex-traffic-state/);
  assert.match(managerInject, /data-anticodex-traffic-signature/);
  assert.match(managerInject, /data-anticodex-notice-action/);
  assert.match(managerInject, /data-anticodex-notice-action": "dismiss"/);
  assert.match(managerInject, /runActionViaBridge\("accountProxy"\)/);
  assert.match(managerInject, /\\u6253\\u5f00\\u7ba1\\u7406/);
  assert.match(managerInject, /\\u91cd\\u65b0\\u68c0\\u67e5/);
  assert.match(managerInject, /document\.getElementById\(TRAFFIC_NOTICE_ID\)\?\.remove\(\)/);
  assert.doesNotMatch(managerInject, /catch \{\s*document\.getElementById\(TRAFFIC_NOTICE_ID\)\?\.remove\(\)/);
  assert.match(managerInject, /ChatGPT \\u767b\\u5f55/);
  assert.match(managerBridge, /\/backend-api\/wham\/apps/);
  assert.match(managerInject, /__ANTICODEX_REFRESH_MANAGER_PANEL__/);
  assert.match(managerInject, /\\u9884\\u8ba1 1 \\u5206\\u949f/);
  assert.match(managerInject, /width:88px/);
  assert.match(managerInject, /height:48px/);
  assert.match(managerInject, /\.anticodex-close\{[^}]*margin:0/);
  assert.match(managerInject, /\.anticodex-close\{[^}]*align-items:center/);
  assert.match(managerInject, /\.anticodex-close\{[^}]*justify-content:center/);
  assert.match(managerInject, /\.anticodex-close\{[^}]*border-radius:9px/);
  assert.match(managerInject, /\.anticodex-close\{[^}]*flex:0 0 auto/);
  assert.match(managerInject, /\.anticodex-close\{[^}]*overflow:hidden/);
  assert.match(managerInject, /\.anticodex-close>span\{[^}]*pointer-events:none/);
  assert.match(managerInject, /pointer-events:auto/);
  assert.match(managerInject, /touch-action:manipulation/);
  const dailyManagerActions = extractJsSetBlock(managerInject, "DAILY_ACTION_IDS");
  const highImpactManagerActions = extractJsSetBlock(managerInject, "HIGH_IMPACT_ACTION_IDS");
  assert.deepEqual(dailyManagerActions.sort(), [
    "accountProxy",
    "accountSwitch",
    "diagnosticsBundle",
    "mcpSkills",
    "pluginCapabilities",
    "refreshModels",
    "refreshStatus",
    "repairShortcuts",
    "secondAccountLoginStatus",
    "sourcePreflight",
    "syncReadiness",
    "updateCheck",
    "viewLatestReports",
  ].sort());
  assert.deepEqual(highImpactManagerActions.sort(), [
    "fastOverallNoTraffic",
    "overallNoTraffic",
    "postVerificationFull",
    "refreshFeatures",
    "resetAntigravitySessionLock",
    "coldRelaunch",
    "stabilitySoak",
    "syncHost",
    "upstreamConfig",
  ].sort());
  assert.match(managerInject, /HIGH_IMPACT_CONFIRMATION_MS/);
  assert.match(managerInject, /function requireHighImpactConfirmation/);
  assert.match(managerInject, /pendingHighImpactAction/);
  assert.match(managerInject, /data-confirming-high-impact/);
  assert.match(managerInject, /function removeManager\(\)[\s\S]*clearInterval\(window\.__ANTICODEX_MANAGER_STATUS_TIMER__\)[\s\S]*delete window\.__ANTICODEX_MANAGER_STATUS_TIMER__/);
  assert.match(managerInject, /const existing = document\.getElementById\(MANAGER_ID\)[\s\S]*data-anticodex-open-refresh[\s\S]*__ANTICODEX_REFRESH_MANAGER_PANEL__\?\.\(\)/);
  assert.match(managerOpenInject, /existingOverlay[\s\S]*data-anticodex-open-refresh[\s\S]*__ANTICODEX_REFRESH_MANAGER_PANEL__\?\.\(\)/);
  const managerClickHandler = managerInject.slice(managerInject.indexOf('button.addEventListener("click", async () => {'));
  assert.ok(
    managerClickHandler.indexOf("requireHighImpactConfirmation(action, label, button)") < managerClickHandler.indexOf('if (action === "upstreamConfig")'),
    "embedded manager must confirm upstreamConfig before opening the config panel",
  );
  assert.ok(
    managerClickHandler.indexOf("if (actionInFlight)") < managerClickHandler.indexOf("requireHighImpactConfirmation(action, label, button)"),
    "embedded manager must block already-running actions before asking for high-impact confirmation",
  );
  assert.ok(
    managerClickHandler.indexOf('if (action !== "refreshStatus" && actionStillPending(action))') < managerClickHandler.indexOf("requireHighImpactConfirmation(action, label, button)"),
    "embedded manager must block pending duplicate actions before asking for high-impact confirmation",
  );
  assert.ok(
    managerClickHandler.indexOf("requireHighImpactConfirmation(action, label, button)") < managerClickHandler.indexOf("runActionViaBridge(action)"),
    "embedded manager must confirm high-impact actions before calling the bridge",
  );
  assert.match(managerInject, /data-action-group/);
  assert.match(managerInject, /anticodex-action-section/);
  assert.match(managerInject, /anticodex-action-danger/);
  assert.match(managerInject, /function detectHostTheme/);
  assert.match(managerInject, /function syncManagerTheme/);
  assert.match(managerInject, /electron/);
  assert.match(managerInject, /classTokens\.includes\("light"\)/);
  assert.match(managerInject, /classTokens\.includes\("dark"\)/);
  assert.match(managerInject, /MutationObserver/);
  assert.match(managerInject, /prefers-color-scheme:\s*dark/);
  assert.match(managerInject, /data-anticodex-theme/);
  assert.match(managerInject, /\[data-anticodex-theme="light"\]/);
  assert.match(managerInject, /\\u65e5\\u5e38\\u64cd\\u4f5c/);
  assert.match(managerInject, /\\u7ef4\\u62a4\\u4e0e\\u9ad8\\u5f71\\u54cd\\u64cd\\u4f5c/);
  assert.match(managerInject, /function safeJson/);
  assert.match(managerInject, /safeValue/);
  assert.match(managerInject, /function snapshotResponse\(path\)/);
  assert.match(managerInject, /const snapshotFallback = snapshotResponse\(path\)/);
  assert.match(managerInject, /const allowSnapshotFallback = options\.allowSnapshotFallback !== false/);
  assert.match(managerInject, /&& \(!options\.method \|\| String\(options\.method\)\.toUpperCase\(\) === "GET"\)/);
  assert.match(managerInject, /if \(allowSnapshotFallback && snapshotFallback\) return snapshotFallback/);
  assert.ok(
    managerInject.indexOf("for (const baseUrl of candidates)") < managerInject.indexOf("if (allowSnapshotFallback && snapshotFallback) return snapshotFallback"),
    "manager GET reads must try the live gateway before stale snapshot fallback",
  );
  assert.match(managerInject, /function ensureSnapshotForLoad/);
  assert.match(managerInject, /__ANTICODEX_MANAGER_SNAPSHOT_IN_FLIGHT__/);
  assert.match(managerInject, /__ANTICODEX_RUN_MANAGER_ACTION__\("refreshStatus"\)/);
  assert.match(managerInject, /LOAD_FETCH_TIMEOUT_MS = 2500/);
  assert.match(managerInject, /LOAD_SNAPSHOT_TIMEOUT_MS = 30000/);
  assert.match(managerInject, /AbortController/);
  assert.match(managerInject, /anticodex-loading/);
  assert.match(managerInject, /loadErrors/);
  assert.match(managerInject, /\\u72b6\\u6001\\u5df2\\u90e8\\u5206\\u5237\\u65b0/);
  assert.match(managerInject, /function actionApiCandidates/);
  assert.match(managerInject, /\/anticodex\/manager\/action-script/);
  assert.match(managerInject, /callbackName/);
  assert.match(managerInject, /data-anticodex-close/);
  assert.match(managerInject, /data-anticodex-result/);
  assert.match(managerInject, /\\u771f\\u5b9e\\u5de5\\u5177\\u8c03\\u7528/);
  assert.match(managerInject, /repairShortcuts/);
  assert.match(managerInject, /\\u4fee\\u590d\\u5feb\\u6377\\u65b9\\u5f0f/);
  assert.doesNotMatch(managerInject, /MCP \\u5165\\u53e3/);
  assert.match(managerInject, /\\u6e05\\u5355\\u53ef\\u89c1/);
  assert.doesNotMatch(managerInject, /createElement\("iframe"\)|<iframe/i);
  assert.match(managerOpenInject, /window\.__ANTICODEX_OPEN_MANAGER__\(\)/);
  assert.match(managerOpenInject, /anticodex-manager-overlay/);
  assert.match(managerOpenInject, /existingOverlay/);
  assert.doesNotMatch(managerOpenInject, /getElementById\("anticodex-manager-overlay"\)\?\.remove\(\)/);
  assert.match(managerOpenInject, /__ANTICODEX_MANAGER_VERSION__\s*===\s*["']native-panel-v99["']/);
  assert.match(syncReadiness, /__ANTICODEX_MANAGER_VERSION__\\s\*===\\s\*"native-panel-v99"/);
  assert.match(uiState, /window\.__ANTICODEX_MANAGER_VERSION__ === "native-panel-v99"/);
  assert.doesNotMatch(managerOpenInject, /\/anticodex\/manager\/inject\.js/);
  assert.doesNotMatch(managerOpenInject, /createElement\("script"\)/);
  const openCallIndex = managerOpenInject.indexOf("__ANTICODEX_OPEN_MANAGER__()");
  const versionCheckIndex = managerOpenInject.indexOf("__ANTICODEX_MANAGER_VERSION__");
  assert.ok(versionCheckIndex < openCallIndex, "opener must check the inject version before calling the open function");
  assert.match(cdpInject, /ANTICODEX_MANAGER_API/);
  assert.match(cdpInject, /ANTICODEX_MANAGER_API_CANDIDATES/);
  assert.match(cdpInject, /ANTICODEX_MANAGER_SNAPSHOT/);
  assert.match(cdpInject, /fetchManagerJson/);
  assert.match(cdpInject, /AbortController/);
  assert.match(cdpInject, /MANAGER_FETCH_TIMEOUT_MS/);
  assert.match(cdpInject, /score:\s*0,\s*url:\s*`http:\/\/127\.0\.0\.1/);
  assert.match(cdpInject, /exceptionDetails/);
  assert.match(cdpInject, /Manager injection failed/);
  assert.match(cdpInject, /if \(!response\.ok\)/);
  assert.match(cdpInject, /\^198\\\.\(1\[89\]\|\[2-9\]\\d\)\\\./);
  assert.match(managerBridge, /__ANTICODEX_MANAGER_ACTION_QUEUE__/);
  assert.match(managerBridge, /splice\(0\)/);
  assert.match(managerBridge, /__ANTICODEX_RUN_MANAGER_ACTION__/);
  assert.match(managerBridge, /\/anticodex\/manager\/action/);
  assert.match(managerBridge, /const token = await bootstrapManagerActionToken\(\);[\s\S]*?try \{[\s\S]*?return await postManagerActionWithToken\(token\);/);
  assert.match(managerBridge, /"x-anticodex-manager-token": token/);
  assert.doesNotMatch(managerBridge, /"x-anticodex-manager-token": bootstrap\.token/);
  assert.match(managerBridge, /error\?\.statusCode !== 403/);
  assert.match(managerBridge, /return await postManagerActionWithToken\(await bootstrapManagerActionToken\(\)\)/);
  assert.match(managerBridge, /\/backend-api\/ps\/plugins\/installed/);
  assert.match(managerBridge, /\/backend-api\/aip\/connectors/);
  assert.match(managerBridge, /__ANTICODEX_MANAGER_SNAPSHOT__/);
  assert.match(managerBridge, /__ANTICODEX_REFRESH_MANAGER_PANEL__/);
  assert.match(managerBridge, /function reportSummaryLines/);
  assert.match(managerBridge, /function failureSummaryLine/);
  assert.match(managerBridge, /function latestReportsSummary/);
  assert.match(managerBridge, /releaseGateGroups/);
  assert.match(managerInject, /releaseGateGroups/);
  assert.match(managerBridge, /releaseGateSelectedReports/);
  assert.match(managerInject, /releaseGateSelectedReports/);
  assert.match(managerBridge, /selectedHistory/);
  assert.match(managerInject, /selectedHistory/);
  assert.match(managerBridge, /releaseGateFailureReasons/);
  assert.match(managerInject, /releaseGateFailureReasons/);
  assert.match(managerBridge, /failureReasons/);
  assert.match(managerInject, /failureReasons/);
  assert.match(managerServerSource, /failureReasonsAvailableCount/);
  assert.match(managerBridge, /failureReasonsHiddenCount/);
  assert.match(managerInject, /failureReasonsHiddenCount/);
  assert.match(managerServerSource, /failureReasonsHiddenCount/);
  assert.match(managerServerSource, /semanticFailuresAvailableCount/);
  assert.match(managerBridge, /semanticFailuresHiddenCount/);
  assert.match(managerInject, /semanticFailuresHiddenCount/);
  assert.match(managerServerSource, /semanticFailuresHiddenCount/);
  assert.match(managerBridge, /nextActions/);
  assert.match(managerInject, /nextActions/);
  assert.match(managerServerSource, /nextActions/);
  assert.match(managerBridge, /function actionDisplayLabel/);
  assert.match(managerInject, /function actionDisplayLabel/);
  assert.match(managerServerSource, /function actionDisplayLabel/);
  assert.match(managerBridge, /function failureReasonDisplayLabel/);
  assert.match(managerInject, /function failureReasonDisplayLabel/);
  assert.match(managerServerSource, /function failureReasonDisplayLabel/);
  for (const marker of ["ageHours", "fresh", "selectedFromHistory", "historySourceMismatch", "requiredForShort", "requiredForRelease"]) {
    assert.match(managerBridge, new RegExp(marker));
    assert.match(managerInject, new RegExp(marker));
    assert.match(managerServerSource, new RegExp(marker));
  }
  assert.match(managerBridge, /sourceMismatch=/);
  assert.match(managerInject, /sourceMismatch=/);
  assert.match(managerServerSource, /sourceMismatch=/);
  assert.match(managerBridge, /releaseBlockedOnlyByRequiredRealTraffic/);
  assert.match(managerInject, /releaseBlockedOnlyByRequiredRealTraffic/);
  assert.match(managerServerSource, /releaseBlockedOnlyByRequiredRealTraffic/);
  assert.match(managerBridge, /required real-traffic evidence only/);
  assert.match(managerInject, /required real-traffic evidence only/);
  assert.match(managerServerSource, /required real-traffic evidence only/);
  assert.match(managerBridge, /blockedUntilExplicitUserApproval/);
  assert.match(managerInject, /blockedUntilExplicitUserApproval/);
  assert.match(managerServerSource, /blockedUntilExplicitUserApproval/);
  for (const marker of ["reportOnly", "approval", "gateway", "realTraffic", "highImpact"]) {
    assert.match(managerBridge, new RegExp(`flags\\.push\\("${marker}"\\)`));
    assert.match(managerInject, new RegExp(`flags\\.push\\("${marker}"\\)`));
    assert.match(managerServerSource, new RegExp(`flags\\.push\\("${marker}"\\)`));
  }
  assert.match(managerBridge, /mergedNextActionObjects/);
  assert.match(managerInject, /mergedNextActionObjects/);
  assert.match(managerServerSource, /mergedNextActionObjects/);
  for (const marker of ["actionReasons: ", "actionGuidance: ", "__fallbackGateId"]) {
    assert.match(managerBridge, new RegExp(marker));
    assert.match(managerInject, new RegExp(marker));
    assert.match(managerServerSource, new RegExp(marker));
  }
  assert.match(managerBridge, /hiddenNextActions/);
  assert.match(managerInject, /hiddenNextActions/);
  assert.match(managerServerSource, /hiddenNextActions/);
  for (const marker of ["nextActionsHiddenCount", "nextActionsAvailableCount", "hidden of"]) {
    assert.match(managerBridge, new RegExp(marker));
    assert.match(managerInject, new RegExp(marker));
    assert.match(managerServerSource, new RegExp(marker));
  }
  assert.match(managerBridge, /item\.nextActionsHiddenCount != null/);
  assert.match(managerInject, /item\.nextActionsHiddenCount != null/);
  assert.match(managerServerSource, /item\.nextActionsHiddenCount!=null/);
  assert.match(managerBridge, /item\.nextActionsAvailableCount != null/);
  assert.match(managerInject, /item\.nextActionsAvailableCount != null/);
  assert.match(managerServerSource, /item\.nextActionsAvailableCount!=null/);
  assert.match(managerServerSource, /nextActionsAvailableCount,\s*nextActionsHiddenCount,\s*nextActionsTruncated,/);
  for (const marker of ["hiddenFailureReasons", "hiddenReportFailures", "hiddenGuidance", "hiddenGateFailures"]) {
    assert.match(managerBridge, new RegExp(marker));
    assert.match(managerInject, new RegExp(marker));
    assert.match(managerServerSource, new RegExp(marker));
  }
  assert.match(managerBridge, /approvalPlan: actions=/);
  assert.match(managerInject, /approvalPlan: actions=/);
  assert.match(managerServerSource, /approvalPlan: actions=/);
  assert.match(managerBridge, /approvalPhases:/);
  assert.match(managerInject, /approvalPhases:/);
  assert.match(managerServerSource, /approvalPhases:/);
  for (const marker of ["reportOnly", "gateway", "realTraffic", "highImpact", "blocked"]) {
    assert.match(managerBridge, new RegExp(`flags\\.push\\("${marker}"\\)`));
    assert.match(managerInject, new RegExp(`flags\\.push\\("${marker}"\\)`));
    assert.match(managerServerSource, new RegExp(`flags\\.push\\("${marker}"\\)`));
  }
  assert.match(managerBridge, /reportOnly=\$\{plan\.reportOnlyCount/);
  assert.match(managerInject, /reportOnly=\$\{plan\.reportOnlyCount/);
  assert.match(managerServerSource, /reportOnly="\+\(plan\.reportOnlyCount/);
  assert.match(managerBridge, /approvalPlan: actions=.*blocked=/);
  assert.match(managerInject, /approvalPlan: actions=.*blocked=/);
  assert.match(managerServerSource, /approvalPlan: actions=.*blocked=/);
  assert.match(managerBridge, /required=\$\{plan\.requiredForShortCount/);
  assert.match(managerInject, /required=\$\{plan\.requiredForShortCount/);
  assert.match(managerServerSource, /required="\+\(plan\.requiredForShortCount/);
  assert.match(managerServerSource, /function reportNonNegativeInt/);
  assert.doesNotMatch(managerServerSource, /Number\.isFinite\(Number\(report\.approvalPlan\./);
  assert.match(managerBridge, /missingOpt=/);
  assert.match(managerInject, /missingOpt=/);
  assert.match(managerServerSource, /missingOpt=/);
  assert.match(managerBridge, /missingReq=/);
  assert.match(managerInject, /missingReq=/);
  assert.match(managerServerSource, /missingReq=/);
  assert.match(managerBridge, /reportFailureSampleCodes/);
  assert.match(managerInject, /reportFailureSampleCodes/);
  assert.match(managerServerSource, /reportFailureSampleCodes/);
  assert.match(managerBridge, /真实流量验收证据需更新\/未生成/);
  assert.match(managerInject, /真实流量验收证据需更新\/未生成/);
  assert.match(managerServerSource, /真实流量验收证据需更新\/未生成/);
  assert.match(managerBridge, /group === "real-traffic"/);
  assert.match(managerInject, /group === "real-traffic"/);
  assert.match(managerServerSource, /group==="real-traffic"/);
  assert.match(managerBridge, /missing_report/);
  assert.match(managerInject, /missing_report/);
  assert.match(managerServerSource, /missing_report/);
  assert.match(managerBridge, /installedRuntimeEvidence/);
  assert.match(managerInject, /installedRuntimeEvidence/);
  assert.match(managerBridge, /installedRuntime: satisfied=/);
  assert.match(managerInject, /installedRuntime: satisfied=/);
  assert.match(managerBridge, /files=/);
  assert.match(managerInject, /files=/);
  assert.match(managerBridge, /sourceMtime=/);
  assert.match(managerInject, /sourceMtime=/);
  assert.match(managerBridge, /installedRuntime drift:/);
  assert.match(managerInject, /installedRuntime drift:/);
  assert.match(managerBridge, /optionalRealTraffic: strict=/);
  assert.match(managerInject, /optionalRealTraffic: strict=/);
  assert.match(managerBridge, /optionalRealTrafficFailures/);
  assert.match(managerInject, /optionalRealTrafficFailures/);
  assert.match(managerBridge, /missingShort/);
  assert.match(managerInject, /missingShort/);
  assert.match(managerBridge, /missingOptional/);
  assert.match(managerInject, /missingOptional/);
  assert.match(managerBridge, /damagedReports/);
  assert.match(managerInject, /damagedReports/);
  assert.match(managerBridge, /releaseGateFailures/);
  assert.match(managerInject, /releaseGateFailures/);
  assert.match(managerBridge, /semanticFailures/);
  assert.match(managerInject, /semanticFailures/);
  assert.match(managerBridge, /plugin offline snapshot:/);
  assert.match(managerInject, /plugin offline snapshot:/);
  assert.match(managerServerSource, /plugin offline snapshot:/);
  assert.match(managerBridge, /runtimeGateway=required/);
  assert.match(managerInject, /runtimeGateway=required/);
  assert.match(managerServerSource, /runtimeGateway=required/);
  assert.match(managerBridge, /sourceSnapshotEvidence/);
  assert.match(managerInject, /sourceSnapshotEvidence/);
  assert.match(managerBridge, /sourceSnapshot: files=/);
  assert.match(managerInject, /sourceSnapshot: files=/);
  assert.match(managerBridge, /source snapshot refresh: refresh local features first, then run normal MCP\/Skill and plugin capability verifiers/);
  assert.match(managerInject, /source snapshot refresh: refresh local features first, then run normal MCP\/Skill and plugin capability verifiers/);
  assert.match(managerServerSource, /source snapshot refresh: refresh local features first, then run normal MCP\/Skill and plugin capability verifiers/);
  assert.match(managerBridge, /do not edit latest report JSON by hand/);
  assert.match(managerInject, /do not edit latest report JSON by hand/);
  assert.match(managerServerSource, /do not edit latest report JSON by hand/);
  assert.match(managerBridge, /cacheHitCount/);
  assert.match(managerInject, /cacheHitCount/);
  assert.match(managerBridge, /sourcePreflightEvidence/);
  assert.match(managerInject, /sourcePreflightEvidence/);
  assert.match(managerBridge, /localConnectorVerifierOk/);
  assert.match(managerInject, /localConnectorVerifierOk/);
  assert.match(managerBridge, /antigravityCliProfilePrepareOk/);
  assert.match(managerInject, /antigravityCliProfilePrepareOk/);
  assert.match(managerBridge, /winUserLogin=/);
  assert.match(managerInject, /winUserLogin=/);
  assert.match(managerBridge, /sourcePreflight windowsUserLogin:/);
  assert.match(managerInject, /sourcePreflight windowsUserLogin:/);
  assert.match(managerBridge, /sourcePreflight windowsUserLogin readiness:/);
  assert.match(managerInject, /sourcePreflight windowsUserLogin readiness:/);
  assert.match(managerBridge, /sourcePreflight profilePrepare: traffic=/);
  assert.match(managerInject, /sourcePreflight profilePrepare: traffic=/);
  assert.match(managerBridge, /sourcePreflight profilePrepare caveat:/);
  assert.match(managerInject, /sourcePreflight profilePrepare caveat:/);
  assert.match(managerBridge, /publicDocumentationClientCopySyncContractOk/);
  assert.match(managerInject, /publicDocumentationClientCopySyncContractOk/);
  assert.match(managerBridge, /clientCopyDocs=/);
  assert.match(managerInject, /clientCopyDocs=/);
  assert.match(managerBridge, /uiStateSelfTestOk/);
  assert.match(managerInject, /uiStateSelfTestOk/);
  assert.match(managerBridge, /translatorRegressionOk/);
  assert.match(managerInject, /translatorRegressionOk/);
  assert.match(managerBridge, /modelThinkingEvidence/);
  assert.match(managerInject, /modelThinkingEvidence/);
  assert.match(managerBridge, /reasoningLevels/);
  assert.match(managerInject, /reasoningLevels/);
  assert.match(managerBridge, /mcpSkillEvidence/);
  assert.match(managerInject, /mcpSkillEvidence/);
  assert.match(managerBridge, /mcpSmokePassed/);
  assert.match(managerInject, /mcpSmokePassed/);
  assert.match(managerBridge, /mcpRealCallPassed/);
  assert.match(managerInject, /mcpRealCallPassed/);
  assert.match(managerBridge, /mcpRealListCount/);
  assert.match(managerInject, /mcpRealListCount/);
  assert.match(managerBridge, /mcpRealListPassed/);
  assert.match(managerInject, /mcpRealListPassed/);
  assert.match(managerBridge, /mcpRealListToolCount/);
  assert.match(managerInject, /mcpRealListToolCount/);
  assert.match(managerBridge, /list \$\{evidence\.mcpRealListPassed/);
  assert.match(managerInject, /list \$\{evidence\.mcpRealListPassed/);
  assert.match(managerBridge, /agentsSkillCount/);
  assert.match(managerInject, /agentsSkillCount/);
  assert.match(managerBridge, /hashCacheHitCount/);
  assert.match(managerInject, /hashCacheHitCount/);
  assert.match(managerBridge, /appToolRegistryExists/);
  assert.match(managerInject, /appToolRegistryExists/);
  assert.match(managerBridge, /appToolRegistryContentMatches/);
  assert.match(managerInject, /appToolRegistryContentMatches/);
  assert.match(managerBridge, /appToolRegistryFingerprintMatches/);
  assert.match(managerInject, /appToolRegistryFingerprintMatches/);
  assert.match(managerBridge, /app-tool registry:/);
  assert.match(managerInject, /app-tool registry:/);
  assert.match(managerBridge, /const callableSummary = appTools > 0/);
  assert.match(managerInject, /const callableSummary = appTools > 0/);
  assert.match(managerBridge, /metadata-only/);
  assert.match(managerInject, /metadata-only/);
  assert.match(managerBridge, /mcpMissingSharedSample/);
  assert.match(managerInject, /mcpMissingSharedSample/);
  assert.match(managerBridge, /mcpExtraLocalSample/);
  assert.match(managerInject, /mcpExtraLocalSample/);
  assert.match(managerBridge, /mcpChangedSharedCount/);
  assert.match(managerInject, /mcpChangedSharedCount/);
  assert.match(managerBridge, /missingSharedSkillSample/);
  assert.match(managerInject, /missingSharedSkillSample/);
  assert.match(managerBridge, /extraLocalSkillSample/);
  assert.match(managerInject, /extraLocalSkillSample/);
  assert.match(managerBridge, /conflictingDuplicateSkillCount/);
  assert.match(managerInject, /conflictingDuplicateSkillCount/);
  assert.match(managerBridge, /MCP missing:/);
  assert.match(managerInject, /MCP missing:/);
  assert.match(managerBridge, /MCP extra:/);
  assert.match(managerInject, /MCP extra:/);
  assert.match(managerBridge, /MCP changed:/);
  assert.match(managerInject, /MCP changed:/);
  assert.match(managerBridge, /skill missing:/);
  assert.match(managerInject, /skill missing:/);
  assert.match(managerBridge, /skill extra:/);
  assert.match(managerInject, /skill extra:/);
  assert.match(managerBridge, /skill duplicate conflicts:/);
  assert.match(managerInject, /skill duplicate conflicts:/);
  assert.match(managerBridge, /refreshFeatureEvidence/);
  assert.match(managerInject, /refreshFeatureEvidence/);
  assert.match(managerBridge, /refresh parity:/);
  assert.match(managerInject, /refresh parity:/);
  assert.match(managerBridge, /hashCacheHitCount/);
  assert.match(managerInject, /hashCacheHitCount/);
  assert.match(managerBridge, /elapsed=/);
  assert.match(managerInject, /elapsed=/);
  assert.match(managerBridge, /verifyOnly=true/);
  assert.match(managerInject, /verifyOnly=true/);
  assert.match(managerBridge, /refresh drift:/);
  assert.match(managerInject, /refresh drift:/);
  assert.match(managerBridge, /refresh recovery:/);
  assert.match(managerInject, /refresh recovery:/);
  assert.match(managerBridge, /recoveryActions/);
  assert.match(managerInject, /recoveryActions/);
  assert.match(managerBridge, /recoveryActions: \$\{recoveryActionIds\.join/);
  assert.match(managerInject, /recoveryActions: \$\{recoveryActionIds\.join/);
  assert.match(managerBridge, /localConnectorEvidence/);
  assert.match(managerInject, /localConnectorEvidence/);
  assert.match(managerBridge, /local connector parity:/);
  assert.match(managerInject, /local connector parity:/);
  assert.match(managerBridge, /local connector drift:/);
  assert.match(managerInject, /local connector drift:/);
  assert.match(managerBridge, /appToolGetPostExtraFromGet/);
  assert.match(managerInject, /appToolGetPostExtraFromGet/);
  assert.match(managerBridge, /pluginCapabilityEvidence/);
  assert.match(managerInject, /pluginCapabilityEvidence/);
  assert.match(managerBridge, /connectorParityExtraLocalSample/);
  assert.match(managerInject, /connectorParityExtraLocalSample/);
  assert.match(managerBridge, /appToolParityExtraLocalSample/);
  assert.match(managerInject, /appToolParityExtraLocalSample/);
  assert.match(managerBridge, /refreshDrift/);
  assert.match(managerInject, /refreshDrift/);
  assert.match(managerBridge, /reportFailures/);
  assert.match(managerInject, /reportFailures/);
  assert.match(managerBridge, /localGatewayGuidanceLine/);
  assert.match(managerInject, /localGatewayGuidanceLine/);
  assert.match(managerBridge, /local Anti-Codex gateway is offline/);
  assert.match(managerInject, /local Anti-Codex gateway is offline/);
  assert.match(managerBridge, /appToolGetPostExtraFromGetSample/);
  assert.match(managerInject, /appToolGetPostExtraFromGetSample/);
  assert.match(managerBridge, /logDbGuardEvidence/);
  assert.match(managerInject, /logDbGuardEvidence/);
  assert.match(managerBridge, /logDbGuard: protected=/);
  assert.match(managerInject, /logDbGuard: protected=/);
  assert.match(managerBridge, /antigravityCliRealSmoke: login=/);
  assert.match(managerInject, /antigravityCliRealSmoke: login=/);
  assert.match(managerBridge, /antigravityCliRealSmoke caveat:/);
  assert.match(managerInject, /antigravityCliRealSmoke caveat:/);
  assert.match(managerBridge, /antigravityCliRealSmoke lane: role=/);
  assert.match(managerInject, /antigravityCliRealSmoke lane: role=/);
  assert.match(managerBridge, /antigravityCliRealSmoke lane:.*mcpManagedHere=/);
  assert.match(managerInject, /antigravityCliRealSmoke lane:.*mcpManagedHere=/);
  assert.match(managerBridge, /antigravityCliRealSmoke lane:.*mcpOwner=/);
  assert.match(managerInject, /antigravityCliRealSmoke lane:.*mcpOwner=/);
  assert.match(managerBridge, /antigravityCliRealSmoke identity: antiCodexId=/);
  assert.match(managerInject, /antigravityCliRealSmoke identity: antiCodexId=/);
  assert.match(managerBridge, /antigravityCliRealSmoke identity:.*distinct=/);
  assert.match(managerInject, /antigravityCliRealSmoke identity:.*distinct=/);
  assert.match(managerBridge, /antigravityCliProfilePrepare: separateAccount=/);
  assert.match(managerInject, /antigravityCliProfilePrepare: separateAccount=/);
  assert.match(managerBridge, /antigravityCliProfilePrepare caveat:/);
  assert.match(managerInject, /antigravityCliProfilePrepare caveat:/);
  assert.match(managerBridge, /parity drift: connectorMissing=/);
  assert.match(managerInject, /parity drift: connectorMissing=/);
  assert.match(managerBridge, /connectorExtra=/);
  assert.match(managerInject, /connectorExtra=/);
  assert.match(managerBridge, /appToolExtra=/);
  assert.match(managerInject, /appToolExtra=/);
  assert.match(managerBridge, /getPostExtra=/);
  assert.match(managerInject, /getPostExtra=/);
  assert.match(managerBridge, /providerContinuity/);
  assert.match(managerInject, /providerContinuity/);
  assert.match(managerBridge, /providerContinuity: turns=/);
  assert.match(managerInject, /providerContinuity: turns=/);
  assert.match(managerBridge, /markers=/);
  assert.match(managerInject, /markers=/);
  assert.match(managerBridge, /toolPairs: restart=/);
  assert.match(managerInject, /toolPairs: restart=/);
  assert.match(managerBridge, /markerThresholds=/);
  assert.match(managerInject, /markerThresholds=/);
  assert.match(managerBridge, /previousIds: save=/);
  assert.match(managerInject, /previousIds: save=/);
  assert.match(managerBridge, /previousMatches: save=/);
  assert.match(managerInject, /previousMatches: save=/);
  assert.match(managerBridge, /nestedMatches: provider=/);
  assert.match(managerInject, /nestedMatches: provider=/);
  assert.match(managerBridge, /previousChain: save=/);
  assert.match(managerInject, /previousChain: save=/);
  assert.match(managerBridge, /orderedHistory: clean=/);
  assert.match(managerInject, /orderedHistory: clean=/);
  assert.match(managerBridge, /optionalRealProviderEvidence/);
  assert.match(managerInject, /optionalRealProviderEvidence/);
  assert.match(managerBridge, /realProviderToAntigravityReturnEvidence/);
  assert.match(managerInject, /realProviderToAntigravityReturnEvidence/);
  assert.match(managerBridge, /realProviderToAntigravityRoute:/);
  assert.match(managerInject, /realProviderToAntigravityRoute:/);
  assert.match(managerBridge, /requested=/);
  assert.match(managerInject, /requested=/);
  assert.match(managerBridge, /redaction=/);
  assert.match(managerInject, /redaction=/);
  assert.match(managerBridge, /antigravityReturnEvidence/);
  assert.match(managerInject, /antigravityReturnEvidence/);
  assert.match(managerBridge, /fakeProviderToAntigravityRoute:/);
  assert.match(managerInject, /fakeProviderToAntigravityRoute:/);
  assert.match(managerBridge, /coldRelaunchEvidence/);
  assert.match(managerInject, /coldRelaunchEvidence/);
  assert.match(managerBridge, /stabilitySoakEvidence/);
  assert.match(managerInject, /stabilitySoakEvidence/);
  assert.match(managerBridge, /upstreamRequestsDuringLocalEndpoints/);
  assert.match(managerBridge, /unauthorizedAppToolCount/);
  assert.match(managerBridge, /appToolGetPostParityClean/);
  assert.match(managerBridge, /sourceSnapshotLine\(result\)/);
  assert.match(managerInject, /sourceSnapshotLine\(r\)/);
  assert.match(managerBridge, /result\.shortBudgetMode \?/);
  assert.match(managerInject, /r\.shortBudgetMode \?/);
  assert.match(managerBridge, /viewLatestReports/);
  assert.match(managerBridge, /if \(action === "syncReadiness"\) return \[[\s\S]{0,220}failureSummaryLine\(result\)/);
  assert.match(managerBridge, /\\u6700\\u65b0\\u62a5\\u544a/);
  assert.match(managerBridge, /\\u5386\\u53f2\\u62a5\\u544a/);
  assert.match(managerBridge, /\\u5931\\u8d25\\u9879/);
  assert.match(managerBridge, /accountSwitch/);
  assert.match(managerBridge, /\\u5df2\\u6253\\u5f00 Antigravity/);
  assert.match(managerInject, /action === "resetAntigravitySessionLock"/);
  assert.match(managerBridge, /action === "resetAntigravitySessionLock"/);
  const server = readFileSync(resolve(root, "translator", "adaptive-server.mjs"), "utf8");
  assert.match(server, /sourceSnapshotLine\(r\)/);
  assert.match(server, /r\.shortBudgetMode\?/);
  assert.match(server, /reportFailures/);
  assert.match(server, /access-control-allow-private-network/);
  assert.match(server, /x-anticodex-manager-token/);
  assert.match(server, /function isTrustedManagerOriginValue[\s\S]*?if \(!value\) return false/);
  assert.match(server, /function validateManagerSourceRequest/);
  assert.match(server, /if \(!hasOrigin && !hasReferer\)/);
  assert.match(server, /url\.pathname === "\/anticodex\/manager\/bootstrap"[\s\S]*?validateManagerSourceRequest\(req, "manager bootstrap"\)/);
  assert.match(server, /\/anticodex\/manager\/action-script/);
  assert.match(server, /url\.pathname === "\/anticodex\/manager\/action-script"[\s\S]*?validateManagerSourceRequest\(req, "manager action"\)/);
  assert.match(server, /runManagerBridgeAction/);
  assert.match(server, /isValidJsonpCallbackName/);
  assert.match(server, /cacheHitCount/);
  assert.match(server, /sourceSnapshot: files=/);
  assert.match(server, /managerActionScriptResponse/);
  assert.match(server, /function visibleModelPayload/);
  assert.match(server, /display_name/);
  assert.match(server, /CLEAN_MANAGER_ACTION_LABELS/);
  assert.match(server, /function managerActionLabel/);
  assert.match(server, /accountSwitch/);
  assert.match(server, /open-antigravity-account-switch\.ps1/);
  assert.match(server, /managerPanelSnapshotPayload/);
  assert.match(server, /function isValidJsonpCallbackName/);
  assert.ok(
    server.indexOf("isValidJsonpCallbackName") < server.indexOf("managerActionScriptResponse"),
    "callback name validator must be defined before the response helper",
  );
  assert.match(managerInject, /managerToken/);
  assert.match(managerInject, /runActionViaScript/);
  assert.match(managerInject, /actionApiCandidates/);
  assert.match(managerInject, /\/anticodex\/manager\/action-script/);
  assert.match(managerInject, /callbackName/);
  const actionScriptBody = managerInject.slice(
    managerInject.indexOf("async function runActionViaScript"),
    managerInject.indexOf("function kv"),
  );
  assert.doesNotMatch(actionScriptBody, /method: "POST"/);
  assert.match(managerOpenInject, /native-panel-v99/);
  assert.doesNotMatch(managerOpenInject, /native-panel-v92/);
  assert.doesNotMatch(managerOpenInject, /native-panel-v91/);
  assert.doesNotMatch(managerOpenInject, /native-panel-v90/);
  assert.doesNotMatch(managerOpenInject, /native-panel-v89/);
  assert.doesNotMatch(managerOpenInject, /native-panel-v88/);
  assert.doesNotMatch(managerOpenInject, /native-panel-v87/);
  assert.doesNotMatch(managerOpenInject, /native-panel-v86/);
  assert.doesNotMatch(managerOpenInject, /native-panel-v85/);
  assert.doesNotMatch(managerOpenInject, /native-panel-v84/);
  assert.doesNotMatch(managerOpenInject, /native-panel-v68/);
  assert.doesNotMatch(managerOpenInject, /native-panel-v67/);
  assert.doesNotMatch(managerOpenInject, /native-panel-v66/);
  assert.doesNotMatch(managerOpenInject, /native-panel-v4["']/);

  // 鈹€鈹€ manager page HTML template static checks 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
  const htmlMatch = server.match(
    /function anticodexManagerHtml\(\)\s*\{\s*return\s*`([\s\S]*?)`\s*;/,
  );
  assert.ok(htmlMatch, "anticodexManagerHtml template must be extractable");
  const html = htmlMatch[1];

  assert.match(html, /<title>Anti-Codex /, "fallback manager title must keep the Anti-Codex brand");
  assert.match(html, /ChatGPT/, "fallback manager must mention ChatGPT login avoidance");
  assert.match(html, /\p{Script=Han}/u, "fallback manager page HTML must contain readable Chinese text");
  assert.doesNotMatch(html, /\uFFFD/, "fallback manager HTML must not contain replacement characters");

  // data-action buttons
  const dataActionMatches = [...html.matchAll(/data-action="([^"]+)"/g)];
  assert.ok(dataActionMatches.length >= 10, "manager page must have at least 10 data-action buttons");
  const actionNames = dataActionMatches.map((m) => m[1]);
  assert.ok(actionNames.includes("accountSwitch"), "data-action list must include accountSwitch");
  assert.ok(actionNames.includes("updateCheck"), "data-action list must include updateCheck");
  assert.ok(actionNames.includes("syncHost"), "data-action list must include syncHost");
  assert.ok(actionNames.includes("upstreamConfig"), "data-action list must include upstreamConfig");
  assert.ok(actionNames.includes("fastOverallNoTraffic"), "data-action list must include fastOverallNoTraffic");
  assert.ok(actionNames.includes("overallNoTraffic"), "data-action list must include overallNoTraffic");
  assert.ok(actionNames.includes("refreshFeatures"), "data-action list must include refreshFeatures");
  assert.ok(actionNames.includes("stabilitySoak"), "data-action list must include stabilitySoak");
  assert.ok(actionNames.includes("coldRelaunch"), "data-action list must include coldRelaunch");
  assert.ok(actionNames.includes("repairShortcuts"), "data-action list must include repairShortcuts");
  assert.ok(actionNames.includes("sourcePreflight"), "data-action list must include sourcePreflight");
  assert.ok(actionNames.includes("viewLatestReports"), "data-action list must include viewLatestReports");
  assert.ok(actionNames.includes("secondAccountLoginStatus"), "data-action list must include secondAccountLoginStatus");
  assert.match(html, /data-action="repairShortcuts"/, "fallback manager must expose repair-shortcuts action");
  assert.match(html, /data-action="upstreamConfig"/, "fallback manager must expose third-party API configuration");
  assert.match(html, /data-action="fastOverallNoTraffic"/, "fallback manager must expose no-traffic fast check");
  assert.doesNotMatch(html, /data-action=".*real.*traffic"/i, "default buttons must not suggest real traffic");
  const managerActionMatches = [...html.matchAll(/data-manager-action="([^"]+)"/g)];
  assert.deepEqual(managerActionMatches.map((match) => match[1]).sort(), [
    "accountProxy",
    "accountSwitch",
    "diagnosticsBundle",
    "fastOverallNoTraffic",
    "coldRelaunch",
    "mcpSkills",
    "overallNoTraffic",
    "pluginCapabilities",
    "postVerificationFull",
    "refreshFeatures",
    "resetAntigravitySessionLock",
    "refreshModels",
    "refreshStatus",
    "repairShortcuts",
    "secondAccountLoginStatus",
    "sourcePreflight",
    "stabilitySoak",
    "syncHost",
    "syncReadiness",
    "updateCheck",
    "upstreamConfig",
    "viewLatestReports",
  ].sort());
  assert.match(html, /data-action-group="daily"/);
  assert.match(html, /data-action-group="high-impact"/);
  assert.match(html, /color-scheme:\s*light dark/);
  assert.match(html, /@media\s*\(prefers-color-scheme:\s*light\)/);
  const dailySection = html.match(/data-action-group="daily"[^>]*>([\s\S]*?)<\/section>/)?.[1] || "";
  const highImpactSection = html.match(/data-action-group="high-impact"[^>]*>([\s\S]*?)<\/section>/)?.[1] || "";
  const fallbackDailyActions = [...dailySection.matchAll(/data-manager-action="([^"]+)"/g)].map((match) => match[1]);
  const fallbackHighImpactActions = [...highImpactSection.matchAll(/data-manager-action="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(fallbackDailyActions.sort(), dailyManagerActions.sort(), "fallback and embedded manager daily action inventory must match");
  assert.deepEqual(fallbackHighImpactActions.sort(), highImpactManagerActions.sort(), "fallback and embedded manager high-impact action inventory must match");
  assert.match(highImpactSection, /class="[^"]*danger[^"]*"/);
  assert.match(highImpactSection, /data-action="upstreamConfig"/);
  assert.match(highImpactSection, /data-action="resetAntigravitySessionLock"/);
  assert.match(highImpactSection, /data-action="coldRelaunch"/);
  assert.equal((highImpactSection.match(/data-manager-action=/g) || []).length, 9);
  assert.match(html, /HIGH_IMPACT_ACTION_IDS=new Set\(\[[^\]]*"resetAntigravitySessionLock"/);
  assert.match(html, /payload\?\.action==="resetAntigravitySessionLock"/);
  assert.match(html, /HIGH_IMPACT_ACTION_IDS/);
  assert.match(html, /HIGH_IMPACT_CONFIRMATION_MS/);
  assert.match(html, /function requireHighImpactConfirmation/);
  assert.match(html, /function setActionButtonsDisabled/);
  assert.match(html, /setActionButtonsDisabled\(true\)[\s\S]*setActionButtonsDisabled\(false\)/);
  assert.match(html, /const reset=r\.result\|\|r/);
  assert.match(html, /if\(item\.exists&&item\.latestPath\)/);
  assert.match(html, /function formatReportAge/);
  assert.match(html, /item\.exists&&age/);
  assert.match(html, /result\.staleCount/);
  assert.match(html, /item\.stale\?"\\\\u9700\\\\u91cd\\\\u8dd1"/);
  assert.match(html, /pendingHighImpactAction/);
  assert.match(html, /data-confirming-high-impact/);
  assert.ok(
    html.indexOf("requireHighImpactConfirmation(action,label,btn)") < html.indexOf('managerPost("/anticodex/manager/action"'),
    "fallback manager must confirm high-impact actions before posting to the action endpoint",
  );

  // actionResult element
  assert.match(html, /<pre[^>]*\bid="actionResult"[^>]*>/, "manager page must have an actionResult pre element");

  // embedded managerActionToken
  assert.match(html, /managerActionToken=\$\{JSON\.stringify\(MANAGER_ACTION_TOKEN\)\}/,
    "manager page must embed managerActionToken from MANAGER_ACTION_TOKEN");

  // client-side action JS sends the token
  assert.match(server, /"x-anticodex-manager-token":managerActionToken/,
    "client-side action JS must send x-anticodex-manager-token");
  assert.match(server, /function refreshManagerActionToken/);
  assert.match(server, /function managerPost/);
  assert.match(server, /e\?\.status!==403/);
  assert.match(server, /managerPost\("\/anticodex\/manager\/action",\{action\}\)/);
  assert.match(repairShortcuts, /CreateShortcut/);
  assert.match(repairShortcuts, /start-anticodex\.ps1/);
  assert.match(repairShortcuts, /sync-anticodex-launcher\.ps1/);
  assert.match(repairShortcuts, /rollback-anticodex-launcher\.ps1/);
  assert.match(repairShortcuts, /manage-anticodex\.ps1/);
  assert.match(repairShortcuts, /anticodex-desktop\.ico/);
  assert.match(repairShortcuts, /latest-\$Name\.json/);
  assert.match(repairShortcuts, /shortcut-repair/);
  assert.match(repairShortcuts, /UTF8Encoding\]::new\(\$false\)/);
  assert.doesNotMatch(repairShortcuts, /sync-anticodex\.ps1"\)/);
  assert.doesNotMatch(repairShortcuts, /Remove-Item\s+-Recurse/);
});

test("Anti-Codex native shortcut launcher has a bounded child wait", () => {
  const launcherSource = readFileSync(resolve(root, "scripts", "AntiCodexLauncher.cs"), "utf8");

  assert.match(launcherSource, /AssemblyTitle\("Anti-Codex"\)/);
  assert.match(launcherSource, /DefaultLauncherTimeoutMs\s*=\s*45000/);
  assert.match(launcherSource, /ANTICODEX_LAUNCHER_TIMEOUT_MS/);
  assert.match(launcherSource, /child\.WaitForExit\(timeoutMs\)/);
  assert.match(launcherSource, /child\.Kill\(\)/);
  assert.match(launcherSource, /return 124/);
  assert.doesNotMatch(launcherSource, /child\.WaitForExit\(\);\s*return child\.ExitCode/);
});

test("Anti-Codex critical host patch lists stay synchronized", () => {
  const brander = readFileSync(resolve(root, "scripts", "brand-patched-asar.mjs"), "utf8");
  const installer = readFileSync(resolve(root, "scripts", "install-anticodex.ps1"), "utf8");
  const validator = readFileSync(resolve(root, "scripts", "test-anticodex-host-candidate.ps1"), "utf8");

  const branderList = extractJsSetBlock(brander, "criticalPatchNames");
  const installerList = extractQuotedListBlock(installer, "criticalPatches = @(");
  const validatorList = extractQuotedListBlock(validator, "$expectedCriticalPatches = @(");

  assert.deepEqual([...new Set(branderList)].sort(), [...new Set(installerList)].sort());
  assert.deepEqual([...new Set(branderList)].sort(), [...new Set(validatorList)].sort());
});

test("Anti-Codex brander patch set is a fixed guarded copy, not a feature-by-feature reimplementation", () => {
  const brander = readFileSync(resolve(root, "scripts", "brand-patched-asar.mjs"), "utf8");

  const patchSpecsStart = brander.indexOf("const patchSpecs = [");
  const patchSpecsEnd = brander.indexOf("const written = [];", patchSpecsStart);
  assert.notEqual(patchSpecsStart, -1, "missing patchSpecs block");
  assert.notEqual(patchSpecsEnd, -1, "missing patchSpecs end marker");
  const patchSpecNames = [...brander.slice(patchSpecsStart, patchSpecsEnd).matchAll(/\["([a-z][a-z0-9-]*)"/g)].map((match) => match[1]);
  assert.ok(patchSpecNames.length >= 10, "brander patchSpecs unexpectedly small; host sync must use an explicit patch list");

  const criticalPatches = extractJsSetBlock(brander, "criticalPatchNames");
  for (const patchName of criticalPatches) {
    assert.ok(patchSpecNames.includes(patchName), `critical patch ${patchName} missing from patchSpecs`);
  }

  assert.match(brander, /do not reimplement per-plugin behavior here/);
  assert.match(brander, /do not reimplement per-model behavior here|patchLocalModelAvailability/);

  const installer = readFileSync(resolve(root, "scripts", "install-anticodex.ps1"), "utf8");
  assert.match(installer, /Anti-Codex is already installed/);
  assert.doesNotMatch(installer, /codex-patched-app\.ok.*Remove-Item.*-HostOnly/);
});

test("Anti-Codex shell shows visible models returned by its local app-server", () => {
  const brander = readFileSync(resolve(root, "scripts", "brand-patched-asar.mjs"), "utf8");

  assert.match(brander, /patchLocalModelAvailability/);
  assert.match(brander, /models-and-reasoning-efforts-/);
  assert.match(brander, /model-list-filter-/);
  assert.match(brander, /\(\?=\[,;\]\)/);
  assert.match(brander, /amazonBedrock/);
  assert.match(brander, /replacement = `let \$\{match\[1\]\}=\[\],/);
  assert.match(brander, /"local-model-availability"/);
});

test("Anti-Codex shell loads installed local plugins without ChatGPT catalog sync", () => {
  const brander = readFileSync(resolve(root, "scripts", "brand-patched-asar.mjs"), "utf8");

  assert.match(brander, /patchLocalPluginCatalog/);
  assert.match(brander, /disable the remote marketplace catalog, not installed local plugins/);
  assert.match(brander, /do not reimplement per-plugin behavior here/);
  assert.match(brander, /local installed-plugin API/);
  assert.match(brander, /app-server-manager-signals-/);
  assert.match(brander, /plugin\/installed/);
  assert.match(brander, /"local-plugin-catalog"/);
  assert.match(brander, /"electron-local-plugin-catalog"/);
  assert.match(brander, /"webview-local-plugin-catalog"/);
  assert.match(brander, /async listPlugins\(\$\{match\[1\]\}\)\{return\{marketplaces:\[\],marketplaceLoadErrors:\[\]\}\}/);
  assert.match(brander, /"list-plugins":[\s\S]*listPlugins\\\(\\\{\\\}\\\)/);
  assert.match(brander, /"list-plugins":\$\{match\[1\]\}\(\$\{match\[2\]\}=>\$\{match\[2\]\}\.listPlugins\(\{\}\)\)/);
  assert.ok(brander.includes(String.raw`/"list-plugins":[\w$]+\(([\w$]+)=>\1\.listPlugins\(\{\}\)\)/.test(text)`));
});

test("Anti-Codex default runtime config is file-auth and Flash-first", () => {
  const config = readFileSync(resolve(root, "codex-home-deepseek-app", "config.adaptive-oneapi.toml"), "utf8");
  const launcher = readFileSync(resolve(root, "scripts", "start-deepcodex.ps1"), "utf8");
  const catalog = JSON.parse(readFileSync(resolve(root, "codex-home-deepseek-app", "deepseek-model-catalog.json"), "utf8"));
  const slugs = catalog.models.map((model) => model.slug);

  assert.match(config, /cli_auth_credentials_store\s*=\s*"file"/);
  assert.match(config, /model_reasoning_effort\s*=\s*"high"/);
  assert.match(config, /model\s*=\s*"gemini-3\.5-flash-low"/);
  assert.match(launcher, /let defaultModel = isAntigravityMode === "True" \? "gemini-3\.5-flash-low" : "gpt-5\.5"/);
  assert.match(launcher, /\$IS_ANTIGRAVITY_MODE -or \(-not \(Test-Path -LiteralPath \$targetConfigTemplate\)\)/);
  assert.ok(launcher.includes('if (isAntigravityMode === "True")'));
  assert.ok(launcher.includes('text = text.replace(/^model\\s*=.*\\r?\\n?/m, "")'));
  assert.equal(slugs[0], "gemini-pro-agent");
  assert.equal(slugs[1], "gemini-3-flash-agent");
  assert.equal(slugs.some((slug) => /^gpt-/i.test(slug)), false);
});

test("Anti-Codex startup registers an explicit workspace as the active desktop project", () => {
  const launcher = readFileSync(resolve(root, "scripts", "start-deepcodex.ps1"), "utf8");

  assert.match(launcher, /\$env:ANTICODEX_WORKSPACE/);
  assert.match(launcher, /electron-saved-workspace-roots/);
  assert.match(launcher, /active-workspace-roots/);
  assert.match(launcher, /electron-workspace-root-labels/);
  assert.match(launcher, /project-order/);
  assert.match(launcher, /state\["active-workspace-roots"\]\s*=\s*\[workspace\]/);
  assert.match(launcher, /workspaceLabel[\s\S]*"Anti-Codex"/);
  assert.match(launcher, /String\(labels\[workspace\]\)\.toLowerCase\(\) === "deepcodex"/);
});

test("Anti-Codex installer creates an isolated copied Codex host", () => {
  const installer = readFileSync(resolve(root, "scripts", "install-anticodex.ps1"), "utf8");
  const brander = readFileSync(resolve(root, "scripts", "brand-patched-asar.mjs"), "utf8");
  const iconGenerator = readFileSync(resolve(root, "scripts", "generate-anticodex-icon.ps1"), "utf8");
  const candidateValidator = readFileSync(resolve(root, "scripts", "test-anticodex-host-candidate.ps1"), "utf8");

  assert.match(installer, /codex-patched-app/);
  assert.match(installer, /codex-patched-app\.ok/);
  assert.match(installer, /Anti-Codex\.exe/);
  assert.match(installer, /Join-Path \$copiedCodex "Anti-Codex\.exe"/);
  assert.match(installer, /brand-patched-asar\.mjs/);
  assert.match(installer, /Anti-Codex\.lnk/);
  assert.match(installer, /Anti-Codex is already installed/);
  assert.match(installer, /Windows branding verification failed/);
  assert.match(installer, /Anti-Codex runtime is incomplete/);
  assert.match(installer, /Join-Path \$toolRoot "rcedit\.exe"/);
  assert.equal(existsSync(resolve(root, "assets", "anticodex.ico")), true);
  assert.equal(existsSync(resolve(root, "assets", "anticodex-icon.png")), true);
  assert.equal(existsSync(resolve(root, "assets", "anticodex-desktop.ico")), true);
  assert.equal(existsSync(resolve(root, "assets", "anticodex-desktop-icon.png")), true);
  assert.equal(existsSync(resolve(root, "assets", "codex-icon-source.png")), true);
  assert.match(iconGenerator, /assets\\codex-icon-source\.png/);
  assert.match(iconGenerator, /resources\\default_app\\icon\.png/);
  assert.match(iconGenerator, /AntiCodexIconCleaner/);
  assert.match(iconGenerator, /IsExternalBackground/);
  assert.match(iconGenerator, /Format32bppArgb/);
  assert.match(iconGenerator, /SourceArtworkPadding/);
  assert.match(iconGenerator, /\$explicitSourcePng/);
  assert.match(iconGenerator, /\$OutputDesktopPng/);
  assert.match(iconGenerator, /\$OutputDesktopIco/);
  assert.match(iconGenerator, /\$DesktopIconSizes\s*=\s*@\(16,\s*24,\s*32,\s*48,\s*64,\s*128,\s*256\)/);
  assert.match(iconGenerator, /Write-Ico \$pink \$OutputDesktopIco \$DesktopIconSizes/);
  assert.doesNotMatch(iconGenerator, /codex-deepseek-icon-final\.png/);
  assert.match(installer, /Install-AntiCodexHostIcon/);
  assert.match(installer, /assets\\anticodex\.ico/);
  assert.match(installer, /assets\\anticodex-desktop\.ico/);
  assert.match(installer, /resources\\icon\.ico/);
  assert.match(installer, /resources\\codex-tray\.ico/);
  assert.match(installer, /Join-Path \$HostRoot "icon\.ico"/);
  assert.match(installer, /patch-exe-icon\.ps1/);
  assert.match(installer, /hostIcon/);
  assert.match(installer, /appRootIcon/);
  assert.match(installer, /trayIcon/);
  assert.match(candidateValidator, /pink Codex cloud with white command marks/);
  assert.match(candidateValidator, /pinkBlobSamples/);
  assert.match(candidateValidator, /whiteCommandSamples/);
  assert.match(candidateValidator, /tealBackgroundSamples/);
  assert.match(candidateValidator, /originalBluePurpleSamples/);
  assert.match(candidateValidator, /"package-json"/);
  assert.match(candidateValidator, /"webview-html-title"/);
  assert.match(candidateValidator, /"profile-dropdown-settings"/);
  assert.match(candidateValidator, /"browser-window-icon"/);
  assert.match(installer, /Remove-Item -LiteralPath \$temp -Recurse -Force/);
  assert.match(installer, /Copy failed after 3 attempts and fallback copy failed/);
  assert.match(installer, /Copy-Item -Path \(Join-Path \$Source "\*"\).*ErrorAction Stop/);
  assert.match(installer, /\/XJ/);
  assert.match(installer, /function Find-PhantomDirectories/);
  assert.match(installer, /\$copyArguments \+= "\/XD"/);
  assert.match(installer, /while excluding \$\(\$phantomDirectories\.Count\) unreadable packaged directories/);
  assert.match(installer, /"\/COPY:DT", "\/DCOPY:DT"/);
  assert.match(installer, /Start-Sleep -Seconds \(15 \* \$attempt\)/);
  assert.match(installer, /Get-ChildItem -LiteralPath \$Source -Filter "\*\.dll"/);
  assert.match(installer, /Start-Sleep -Seconds \(3 \* \$fileAttempt\)/);
  assert.match(installer, /\.anticodex-pending/);
  assert.match(installer, /codex-host-staging/);
  assert.match(installer, /Move-Item -LiteralPath \$copiedCodexStaging -Destination \$copiedCodex/);
  assert.match(installer, /foreach \(\$requiredHostFile in @\("Codex\.exe", "resources\\app\.asar", "resources\\codex\.exe"\)\)/);
  assert.match(installer, /GetFolderPath\("Programs"\)/);
  assert.match(installer, /Sync Anti-Codex with Codex\.lnk/);
  assert.match(installer, /sync-anticodex-launcher\.ps1/);
  assert.doesNotMatch(installer, /DeepCodex\.lnk/);
  assert.match(brander, /productName": "Anti-Codex"/);
  assert.match(brander, /patchBootstrapAppName/);
  assert.match(brander, /app\.name=`Anti-Codex`/);
  assert.match(brander, /"package-json"/);
  assert.match(brander, /"webview-html-title"/);
  assert.match(brander, /"app-name"/);
  assert.match(brander, /"browser-window-icon"/);
  assert.match(brander, /setAppUserModelId\(`AntiCodex`\)/);
  assert.match(brander, /process\.platform===`win32`\|\|process\.platform===`linux`/);
  assert.match(brander, /icon:`icon\.ico`,autoHideMenuBar:!0/);
  assert.doesNotMatch(installer, /deepcodex\.ico/);
});

test("Windows default installer installs Anti-Codex instead of legacy DeepCodex", () => {
  const entry = readFileSync(resolve(root, "install-windows.bat"), "utf8");
  assert.match(entry, /scripts\\install-anticodex\.ps1/);
  assert.match(entry, /Anti-Codex install finished/);
  assert.doesNotMatch(entry, /scripts\\install-deepcodex\.ps1/);
});

test("Anti-Codex ships a Start Menu sync launcher instead of desktop helper shortcuts", () => {
  const installer = readFileSync(resolve(root, "scripts", "install-anticodex.ps1"), "utf8");
  const launcher = readFileSync(resolve(root, "scripts", "sync-anticodex-launcher.ps1"), "utf8");
  const rollbackLauncher = readFileSync(resolve(root, "scripts", "rollback-anticodex-launcher.ps1"), "utf8");
  const readiness = readFileSync(resolve(root, "scripts", "test-anticodex-sync-readiness.ps1"), "utf8");

  assert.match(installer, /Start Menu|GetFolderPath\("Programs"\)|\$startMenuDir/);
  assert.match(installer, /Sync Anti-Codex with Codex\.lnk/);
  assert.match(installer, /sync-anticodex-launcher\.ps1/);
  assert.match(installer, /Rollback Anti-Codex\.lnk/);
  assert.match(installer, /rollback-anticodex-launcher\.ps1/);
  assert.doesNotMatch(installer, /Check Anti-Code|Switch Anti-Cod|Drill Anti-Cod/);
  assert.match(launcher, /sync-anticodex\.ps1/);
  assert.match(launcher, /Anti-Codex was not changed/);
  assert.match(rollbackLauncher, /rollback-anticodex\.ps1/);
  assert.match(rollbackLauncher, /Anti-Codex was not changed/);
  assert.match(readiness, /Sync Anti-Codex with Codex\.lnk/);
  assert.match(readiness, /Rollback Anti-Codex\.lnk/);
  assert.match(readiness, /Desktop/);
  assert.match(readiness, /desktop helper shortcuts should not be present/);
  assert.match(readiness, /forbiddenDesktopHelperShortcuts/);
  assert.match(readiness, /startMenuSyncShortcutExists/);
  assert.match(readiness, /startMenuRollbackShortcutExists/);
  assert.match(readiness, /sync-anticodex-launcher\.ps1/);
  assert.match(readiness, /rollback-anticodex-launcher\.ps1/);
});

test("Anti-Codex shortcut verification records exact targets, names, icons, and scripts", () => {
  const readiness = readFileSync(resolve(root, "scripts", "test-anticodex-sync-readiness.ps1"), "utf8");
  const overall = readFileSync(resolve(root, "scripts", "test-anticodex-installed-overall.ps1"), "utf8");
  const repairShortcuts = readFileSync(resolve(root, "scripts", "repair-anticodex-shortcuts.ps1"), "utf8");

  assert.match(readiness, /function New-AntiCodexShortcutSpec/);
  assert.match(readiness, /function Test-AntiCodexShortcutSpec/);
  assert.match(readiness, /shortcutVerification/);
  assert.match(readiness, /displayName/);
  assert.match(readiness, /expectedScript/);
  assert.match(readiness, /expectedLauncherTarget/);
  assert.match(readiness, /actualLauncherTarget/);
  assert.match(readiness, /launcherTargetMatches/);
  assert.match(readiness, /expectedIconLocation/);
  assert.match(readiness, /scriptMatches/);
  assert.match(readiness, /iconMatches/);
  assert.match(readiness, /displayNameMatches/);
  assert.match(readiness, /forbiddenCodexBranding/);
  assert.match(readiness, /shortcut file name is not Anti-Codex branded/);
  assert.match(readiness, /shortcut still carries Codex-only branding/);
  assert.match(readiness, /shortcut does not launch the expected Anti-Codex script/);
  assert.match(readiness, /shortcut icon does not point at the expected Anti-Codex icon/);
  assert.match(readiness, /Sync Anti-Codex with Codex\.lnk/);
  assert.match(readiness, /Rollback Anti-Codex\.lnk/);
  assert.match(readiness, /Manage Anti-Codex\.lnk/);

  assert.match(overall, /shortcutVerification/);
  assert.match(overall, /shortcut verification did not report exact evidence/);
  assert.match(overall, /launcherTargetMatches/);
  assert.match(overall, /shortcut verification did not prove exact Anti-Codex launcher targets/);

  assert.match(repairShortcuts, /function New-AntiCodexShortcutSpec/);
  assert.match(repairShortcuts, /function Set-AntiCodexShortcut/);
  assert.match(repairShortcuts, /displayName/);
  assert.match(repairShortcuts, /expectedScript/);
  assert.match(repairShortcuts, /expectedLauncherTarget/);
  assert.match(repairShortcuts, /actualLauncherTarget/);
  assert.match(repairShortcuts, /launcherTargetMatches/);
  assert.match(repairShortcuts, /expectedIconLocation/);
  assert.match(repairShortcuts, /actualTarget/);
  assert.match(repairShortcuts, /actualArguments/);
  assert.match(repairShortcuts, /actualIconLocation/);
  assert.match(repairShortcuts, /scriptMatches/);
  assert.match(repairShortcuts, /iconMatches/);
  assert.match(repairShortcuts, /shortcutEvidence/);
  assert.match(repairShortcuts, /Anti-Codex\.lnk/);
  assert.match(repairShortcuts, /Sync Anti-Codex with Codex\.lnk/);
  assert.match(repairShortcuts, /Rollback Anti-Codex\.lnk/);
  assert.match(repairShortcuts, /Manage Anti-Codex\.lnk/);
  assert.doesNotMatch(repairShortcuts, /Description = "Codex/);
});

test("Anti-Codex detects installed Codex version drift and offers safe sync at launch", () => {
  const updateCheck = readFileSync(resolve(root, "scripts", "check-anticodex-update.ps1"), "utf8");
  const launcher = readFileSync(resolve(root, "scripts", "start-anticodex.ps1"), "utf8");
  const readiness = readFileSync(resolve(root, "scripts", "test-anticodex-sync-readiness.ps1"), "utf8");
  const translator = readFileSync(resolve(root, "translator", "adaptive-server.mjs"), "utf8");
  assert.match(updateCheck, /Get-AppxPackage/);
  assert.match(updateCheck, /Get-FileHash/);
  assert.match(updateCheck, /updateNeeded/);
  assert.match(updateCheck, /up_to_date_cached/);
  assert.match(updateCheck, /sync-anticodex-launcher\.ps1/);
  assert.match(updateCheck, /Codex Desktop has been updated/);
  assert.match(updateCheck, /Image\]::FromStream/);
  assert.match(updateCheck, /pinkBlob -ge 120/);
  assert.doesNotMatch(updateCheck, /New-Object System\.Drawing\.Icon/);
  assert.match(launcher, /check-anticodex-update\.ps1/);
  assert.match(readiness, /updateStatus/);
  assert.match(translator, /updateCheck:\s*\{/);
  assert.match(translator, /script:\s*"check-anticodex-update\.ps1"/);
  assert.match(translator, /data-action="updateCheck"/);
  assert.match(translator, /ANTICODEX_STATE_ROOT/);
  assert.match(translator, /dirname\(process\.env\.CODEX_HOME_DIR\)/);
  assert.match(translator, /update-status\.json/);
});

test("Antigravity mode builds the model catalog from the signed-in desktop account", () => {
  const launcher = readFileSync(resolve(root, "scripts", "start-deepcodex.ps1"), "utf8");
  const server = readFileSync(resolve(root, "translator", "adaptive-server.mjs"), "utf8");
  const sync = readFileSync(resolve(root, "translator", "sync-antigravity-model-catalog.mjs"), "utf8");

  assert.match(launcher, /sync-antigravity-model-catalog\.mjs/);
  assert.match(launcher, /ANTIGRAVITY_MODEL_CATALOG_PATH/);
  assert.match(launcher, /if\s*\(\$IS_ANTIGRAVITY_MODE\)\s*\{/);
  assert.match(launcher, /Copy-Item -LiteralPath \$MODEL_CATALOG_TEMPLATE_PATH -Destination \(Join-Path \$CODEX_HOME_DIR "deepseek-model-catalog\.json"\) -Force/);
  assert.match(launcher, /\$LASTEXITCODE -ne 0/);
  assert.match(launcher, /using the last available catalog/i);
  assert.match(launcher, /function Use-CachedAntigravityModelCatalog/);
  assert.match(launcher, /ANTICODEX_FORCE_STARTUP_MODEL_REFRESH/);
  assert.match(launcher, /\$script:MODEL_CATALOG_TEMPLATE_PATH = \$generatedCatalog/);
  assert.match(server, /const CODEX_HOME_DIR = process\.env\.CODEX_HOME_DIR \|\| process\.env\.CODEX_HOME \|\| ""/);
  assert.match(sync, /fetchAvailableAgentModels/);
  assert.match(sync, /buildAntigravityModelCatalog/);
  assert.match(sync, /ANTIGRAVITY_MODEL_DISCOVERY_ATTEMPTS/);
  assert.match(sync, /ANTIGRAVITY_MODEL_DISCOVERY_TIMEOUT_MS/);
});

test("translator-only recovery keeps lightweight snapshots fresh even when DEEPCODEX_SKIP_PLUGIN_SYNC=1", () => {
  const launcher = readFileSync(resolve(root, "scripts", "start-deepcodex.ps1"), "utf8");
  const translatorOnlyStart = launcher.indexOf("if ($TranslatorOnly) {");
  const translatorOnlyEnd = launcher.indexOf("\nSet-DeepCodexRouteIsolation", translatorOnlyStart + 1);
  const translatorOnlyBlock = translatorOnlyStart >= 0 && translatorOnlyEnd > translatorOnlyStart
    ? launcher.slice(translatorOnlyStart, translatorOnlyEnd)
    : "";

  assert.ok(translatorOnlyBlock, "missing translator-only startup block");
  assert.match(launcher, /function Find-AntiCodexLocalAddress/);
  assert.match(launcher, /function Set-AntiCodexTranslatorEndpointDefaults/);
  assert.match(launcher, /Set-AntiCodexTranslatorEndpointDefaults/);
  assert.match(launcher, /\$script:TRANSLATOR_PORT = 8484/);
  assert.match(launcher, /\$env:TRANSLATOR_URL = \$script:TRANSLATOR_URL/);
  assert.match(translatorOnlyBlock, /Seed-RuntimeDefaults/);
  assert.match(launcher, /function Test-AntiCodexStartupSnapshotsReady/);
  assert.match(launcher, /function Sync-AntiCodexStartupSnapshots/);
  assert.match(launcher, /ANTICODEX_FORCE_STARTUP_SNAPSHOTS/);
  assert.match(launcher, /ANTICODEX_STARTUP_SNAPSHOT_MAX_AGE_HOURS/);
  assert.match(launcher, /\$TRANSLATOR_HEALTH_TIMEOUT_MS[\s\S]*else \{ 12000 \}/);
  assert.match(launcher, /\$PRESERVE_TRANSLATOR_ON_EXIT = \$false/);
  assert.match(launcher, /\$PRESERVE_TRANSLATOR_ON_EXIT = \$true/);
  assert.match(launcher, /if \(-not \$PRESERVE_TRANSLATOR_ON_EXIT\) \{/);
  assert.match(launcher, /\.anticodex-startup-snapshots-ready\.json/);
  assert.match(launcher, /anticodex-startup-snapshots-ready-v1/);
  assert.match(launcher, /marker\.sharedCodexHome/);
  assert.match(launcher, /marker\.codexHome/);
  assert.match(launcher, /TotalHours -gt \$ANTICODEX_STARTUP_SNAPSHOT_MAX_AGE_HOURS/);
  assert.match(launcher, /function Get-AntiCodexStartupSourceFingerprint/);
  assert.match(launcher, /--print-startup-source-fingerprint/);
  assert.match(launcher, /marker\.sourceFingerprint -ne \$currentSourceFingerprint/);
  assert.match(translatorOnlyBlock, /Start-TranslatorProcess/);
  const syncIndex = translatorOnlyBlock.indexOf("Sync-AntiCodexStartupSnapshots");
  const startIndex = translatorOnlyBlock.indexOf("Start-TranslatorProcess");
  assert.ok(
    syncIndex >= 0 && startIndex >= 0 && syncIndex < startIndex,
    "translator-only recovery must refresh lightweight local snapshots before Start-TranslatorProcess even when plugin sync is skipped",
  );
  assert.doesNotMatch(translatorOnlyBlock, /if\s*\(\s*-not\s+\$DEEPCODEX_SKIP_PLUGIN_SYNC\s*\)[\s\S]{0,120}Sync-AntiCodexStartupSnapshots/);
  assert.ok(
    translatorOnlyBlock.indexOf("Use-CachedAntigravityModelCatalog") <
      translatorOnlyBlock.indexOf("Start-TranslatorProcess"),
    "translator must load the Antigravity catalog before it starts",
  );
});

test("translator-only Anti-Codex launcher keeps the anticodex state root by default", () => {
  const launcher = readFileSync(resolve(root, "scripts", "start-deepcodex.ps1"), "utf8");

  assert.match(launcher, /\$IS_ANTICODEX_INSTALL_ROOT/);
  assert.match(launcher, /Join-Path \$env:APPDATA "anticodex"/);
  assert.match(launcher, /\$IS_ANTIGRAVITY_MODE = \$env:TRANSLATOR_UPSTREAM_MODE -eq "antigravity" -or \$IS_ANTICODEX_INSTALL_ROOT/);
});

test("launcher refreshes the isolated model catalog after account readiness recovers", () => {
  const launcher = readFileSync(resolve(root, "scripts", "start-deepcodex.ps1"), "utf8");

  assert.match(launcher, /function Get-TranslatorHealthSnapshot/);
  assert.match(launcher, /function Refresh-AntigravityCatalogAfterRecovery/);
  assert.match(launcher, /accountReady/);
  assert.match(
    launcher,
    /\$currentAccountReady\s+-eq\s+\$true[\s\S]*?\$previousAccountReady\s+-ne\s+\$true[\s\S]*?Refresh-AntigravityCatalogAfterRecovery/,
  );
  assert.match(
    launcher,
    /Copy-Item\s+-LiteralPath\s+\$generatedCatalog\s+-Destination\s+\(Join-Path\s+\$CODEX_HOME_DIR\s+"deepseek-model-catalog\.json"\)\s+-Force/,
  );

  const refreshFunction = launcher.match(/function Refresh-AntigravityCatalogAfterRecovery \{[\s\S]*?\n\}/)?.[0];
  assert.ok(refreshFunction, "missing recovery refresh function");
  assert.doesNotMatch(refreshFunction, /Stop-Process|CODEX_BIN|GLOBAL_CODEX_HOME/);
});

test("Antigravity mode avoids slow plugin marketplace startup by default", () => {
  const launcher = readFileSync(resolve(root, "scripts", "start-deepcodex.ps1"), "utf8");
  const pluginHostSync = readFileSync(resolve(root, "scripts", "sync-shared-codex-plugin-host.mjs"), "utf8");

  assert.match(launcher, /DEEPCODEX_SKIP_PLUGIN_SYNC/);
  assert.match(launcher, /Strip-PluginMarketplaceConfig/);
  assert.match(launcher, /setFeatureFlag\(text, "plugins", "false"\)/);
  assert.match(launcher, /setFeatureFlag\(text, "plugin_sharing", "false"\)/);
  assert.match(launcher, /setFeatureFlag\(text, "remote_plugin", "false"\)/);
  assert.match(launcher, /Sync-AntiCodexStartupSnapshots/);
  assert.match(launcher, /Startup local feature snapshots are already ready; skipped lightweight refresh/);
  assert.match(launcher, /cache\\codex_app_directory/);
  assert.match(launcher, /cache\\codex_apps_tools/);
  assert.match(pluginHostSync, /process\.argv\.includes\('--skills-only'\)/);
  assert.match(pluginHostSync, /process\.argv\.includes\('--local-snapshots'\)/);
  assert.match(pluginHostSync, /process\.argv\.includes\('--startup-snapshots'\)/);
  assert.match(pluginHostSync, /process\.argv\.includes\('--print-startup-source-fingerprint'\)/);
  assert.match(pluginHostSync, /ANTICODEX_SNAPSHOT_LOCK_STALE_MS/);
  assert.match(pluginHostSync, /60 \* 1000/);
  assert.match(pluginHostSync, /kept-existing-startup-snapshot/);
  assert.match(pluginHostSync, /anticodex-startup-snapshots-ready-v1/);
  assert.match(pluginHostSync, /marker-write-failed/);
  assert.match(pluginHostSync, /copy-failed' \|\| item\.mode === 'marker-write-failed'/);
  assert.match(pluginHostSync, /codex_app_directory/);
  assert.match(pluginHostSync, /mode:\s*'copy'/);
  assert.match(pluginHostSync, /mode:\s*'copy-file'/);
  assert.match(pluginHostSync, /copyDirectoryContents/);
  assert.match(pluginHostSync, /syncDirectoryTransactional/);
  assert.match(pluginHostSync, /syncFileTransactional/);
  assert.match(pluginHostSync, /function detectDuplicateSkillNames/);
  assert.match(pluginHostSync, /duplicateSkillNames/);
  assert.match(pluginHostSync, /conflictingDuplicateSkillNames/);
  assert.match(pluginHostSync, /conflicting duplicate skill names across shared skill roots/);
  assert.match(pluginHostSync, /acquireSyncLock/);
  assert.match(pluginHostSync, /local snapshot refresh is already running/);
  assert.match(pluginHostSync, /\.tmp-/);
  assert.match(pluginHostSync, /\.old-/);
  assert.match(pluginHostSync, /AGENTS\.md/);
  assert.match(pluginHostSync, /DEFAULT_SKILL_ALLOWLIST\.md/);
  assert.match(pluginHostSync, /RTK\.md/);
  assert.match(pluginHostSync, /MCP_WORKER_USAGE_GUIDE\.md/);
  assert.match(pluginHostSync, /sourceFingerprint/);
  assert.match(pluginHostSync, /sourceMtimeMax/);
  assert.match(pluginHostSync, /computeStartupSourceFingerprint/);
  assert.match(pluginHostSync, /computeSnapshotManifest/);
  assert.match(pluginHostSync, /pruneStaleManifestEntries/);
  assert.match(pluginHostSync, /\.anticodex-source-manifest\.json/);
  assert.match(pluginHostSync, /trackManifest/);
  assert.match(launcher, /if\s*\(-not \$DEEPCODEX_SKIP_PLUGIN_SYNC\)/);
});

test("Anti-Codex imports shared Codex config without writing back to global Codex config", () => {
  const launcher = readFileSync(resolve(root, "scripts", "start-deepcodex.ps1"), "utf8");

  assert.match(launcher, /\$registrationArgs\s*=\s*@\(\$configToml,\s*\$previousToml\)/);
  assert.match(launcher, /if\s*\(-not \$IS_ANTIGRAVITY_MODE\)\s*\{\s*\$registrationArgs\s*\+=\s*\$globalConfig\s*\}/);
  assert.match(launcher, /& \$NODE_BIN \$DEEPCODEX_REGISTRATION_SYNC @registrationArgs/);
  assert.match(launcher, /if\s*\(-not \$IS_ANTIGRAVITY_MODE\)\s*\{\s*Ensure-GlobalPermissionDefaults\s*\}/);
  assert.match(launcher, /& \$NODE_BIN \$SHARED_CONFIG_SYNC \$globalConfig \$configToml/);
  assert.match(launcher, /Shared Codex config sync failed/);
  assert.match(launcher, /Plugin registration sync failed/);
  assert.match(launcher, /Optional local feature sync failed/);
  assert.match(launcher, /Sync-GlobalRules/);

});

test("Anti-Codex imports skills as a local copy instead of linking shared Codex skills", () => {
  const tempRoot = mkdtempSync(resolve(os.tmpdir(), "anticodex-skills-import-"));
  const currentHome = resolve(tempRoot, "current");
  const sharedHome = resolve(tempRoot, "shared");
  const sourceSkill = resolve(sharedHome, "skills", "demo-skill");
  const targetSkill = resolve(currentHome, "skills", "demo-skill");
  mkdirSync(sourceSkill, { recursive: true });
  writeFileSync(resolve(sourceSkill, "SKILL.md"), "# Demo\n");

  try {
    const result = spawnSync(process.execPath, [
      resolve(root, "scripts", "sync-shared-codex-plugin-host.mjs"),
      currentHome,
      sharedHome,
      "--skills-only",
    ], {
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(existsSync(targetSkill), true);
    assert.equal(readFileSync(resolve(targetSkill, "SKILL.md"), "utf8"), "# Demo\n");
    assert.equal(lstatSync(resolve(currentHome, "skills")).isSymbolicLink(), false);

    const summary = JSON.parse(result.stdout);
    assert.equal(summary.ok, true);
    assert.equal(summary.summary[0].relPath, "skills");
    assert.equal(summary.summary[0].mode, "copied");
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("Anti-Codex refuses conflicting duplicate skill names across shared roots", () => {
  const tempRoot = mkdtempSync(resolve(os.tmpdir(), "anticodex-skills-duplicate-"));
  const currentHome = resolve(tempRoot, "current");
  const sharedHome = resolve(tempRoot, "shared");
  const agentsSkills = resolve(tempRoot, "agents-skills");
  const codexSkill = resolve(sharedHome, "skills", "dupe-skill");
  const agentSkill = resolve(agentsSkills, "dupe-skill");
  mkdirSync(codexSkill, { recursive: true });
  mkdirSync(agentSkill, { recursive: true });
  writeFileSync(resolve(codexSkill, "SKILL.md"), "# Codex Dupe\n");
  writeFileSync(resolve(agentSkill, "SKILL.md"), "# Agent Dupe\n");

  try {
    const result = spawnSync(process.execPath, [
      resolve(root, "scripts", "sync-shared-codex-plugin-host.mjs"),
      currentHome,
      sharedHome,
      "--skills-only",
    ], {
      encoding: "utf8",
      env: {
        ...process.env,
        ANTICODEX_EXTRA_SKILLS_ROOTS: agentsSkills,
      },
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const summary = JSON.parse(result.stdout);
    const skillsSummary = summary.summary.find((item) => item.relPath === "skills");
    assert.equal(summary.ok, false);
    assert.equal(skillsSummary.mode, "copy-failed");
    assert.deepEqual(skillsSummary.duplicateSkillNames, ["dupe-skill"]);
    assert.deepEqual(skillsSummary.conflictingDuplicateSkillNames, ["dupe-skill"]);
    assert.match(skillsSummary.error, /conflicting duplicate skill names across shared skill roots/);
    assert.equal(existsSync(resolve(currentHome, "skills", "dupe-skill")), false);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("Anti-Codex refuses conflicting duplicate skill names through linked skill directories", (t) => {
  const tempRoot = mkdtempSync(resolve(os.tmpdir(), "anticodex-skills-linked-duplicate-"));
  const currentHome = resolve(tempRoot, "current");
  const sharedHome = resolve(tempRoot, "shared");
  const agentsSkills = resolve(tempRoot, "agents-skills");
  const codexSkill = resolve(sharedHome, "skills", "dupe-skill");
  const linkedSkillSource = resolve(tempRoot, "linked-dupe-skill");
  const linkedSkill = resolve(agentsSkills, "dupe-skill");
  mkdirSync(codexSkill, { recursive: true });
  mkdirSync(linkedSkillSource, { recursive: true });
  mkdirSync(agentsSkills, { recursive: true });
  writeFileSync(resolve(codexSkill, "SKILL.md"), "# Codex Dupe\n");
  writeFileSync(resolve(linkedSkillSource, "SKILL.md"), "# Linked Agent Dupe\n");
  try {
    symlinkSync(linkedSkillSource, linkedSkill, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (error && (error.code === "EPERM" || error.code === "EACCES" || error.code === "EINVAL")) {
      t.skip("current environment cannot create linked skill directories");
      rmSync(tempRoot, { recursive: true, force: true });
      return;
    }
    throw error;
  }

  try {
    const result = spawnSync(process.execPath, [
      resolve(root, "scripts", "sync-shared-codex-plugin-host.mjs"),
      currentHome,
      sharedHome,
      "--skills-only",
    ], {
      encoding: "utf8",
      env: {
        ...process.env,
        ANTICODEX_EXTRA_SKILLS_ROOTS: agentsSkills,
      },
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const summary = JSON.parse(result.stdout);
    const skillsSummary = summary.summary.find((item) => item.relPath === "skills");
    assert.equal(summary.ok, false);
    assert.deepEqual(skillsSummary.conflictingDuplicateSkillNames, ["dupe-skill"]);
    assert.match(skillsSummary.error, /conflicting duplicate skill names across shared skill roots/);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("Anti-Codex startup snapshots refresh when shared skill content changes", () => {
  const tempRoot = mkdtempSync(resolve(os.tmpdir(), "anticodex-startup-snapshot-refresh-"));
  const currentHome = resolve(tempRoot, "current");
  const sharedHome = resolve(tempRoot, "shared");
  const sourceSkill = resolve(sharedHome, "skills", "demo-skill");
  const targetSkillFile = resolve(currentHome, "skills", "demo-skill", "SKILL.md");
  mkdirSync(sourceSkill, { recursive: true });
  writeFileSync(resolve(sourceSkill, "SKILL.md"), "# Demo v1\n");

  try {
    const first = spawnSync(process.execPath, [
      resolve(root, "scripts", "sync-shared-codex-plugin-host.mjs"),
      currentHome,
      sharedHome,
      "--startup-snapshots",
    ], { encoding: "utf8" });
    assert.equal(first.status, 0, first.stderr || first.stdout);
    assert.equal(readFileSync(targetSkillFile, "utf8"), "# Demo v1\n");

    writeFileSync(resolve(sourceSkill, "SKILL.md"), "# Demo v2\n");
    const second = spawnSync(process.execPath, [
      resolve(root, "scripts", "sync-shared-codex-plugin-host.mjs"),
      currentHome,
      sharedHome,
      "--startup-snapshots",
    ], { encoding: "utf8" });
    assert.equal(second.status, 0, second.stderr || second.stdout);
    const summary = JSON.parse(second.stdout);
    const skillsSummary = summary.summary.find((item) => item.relPath === "skills");
    assert.equal(summary.ok, true);
    assert.equal(skillsSummary.mode, "copied");
    assert.equal(readFileSync(targetSkillFile, "utf8"), "# Demo v2\n");
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("Anti-Codex plugin, connector, and sidecar snapshots are local copies", () => {
  const pluginHostSync = readFileSync(resolve(root, "scripts", "sync-shared-codex-plugin-host.mjs"), "utf8");
  const sidecarSync = readFileSync(resolve(root, "scripts", "sync-shared-codex-sidecars.mjs"), "utf8");
  const independence = readFileSync(resolve(root, "scripts", "test-anticodex-independence.ps1"), "utf8");

  assert.doesNotMatch(pluginHostSync, /mode:\s*'link'/);
  assert.doesNotMatch(pluginHostSync, /symlinkSync/);
  assert.match(pluginHostSync, /relPath: 'plugins'.*mode: 'copy'/s);
  assert.match(pluginHostSync, /relPath: path\.join\('\.tmp', 'plugins'\).*mode: 'copy'/s);
  assert.match(pluginHostSync, /relPath: 'computer-use'.*mode: 'copy'/s);
  assert.match(pluginHostSync, /relPath: 'AGENTS\.md'.*mode: 'copy-file'/s);
  assert.match(pluginHostSync, /relPath: 'DEFAULT_SKILL_ALLOWLIST\.md'.*mode: 'copy-file'/s);
  assert.match(pluginHostSync, /relPath: 'RTK\.md'.*mode: 'copy-file'/s);
  assert.match(pluginHostSync, /relPath: 'MCP_WORKER_USAGE_GUIDE\.md'.*mode: 'copy-file'/s);
  assert.match(pluginHostSync, /mode: 'copied-file'/);
  assert.match(pluginHostSync, /target: targetPath/);
  assert.match(pluginHostSync, /sharedPath/);
  assert.doesNotMatch(pluginHostSync, /mode: 'copied-file',\s*target: sharedPath/s);

  assert.doesNotMatch(sidecarSync, /symlinkSync/);
  assert.match(sidecarSync, /ensureLocalCopy/);
  assert.match(sidecarSync, /copyDirectoryContents/);

  assert.match(independence, /Get-PathState -RelPath "plugins" -RequiredLocalCopy \$true/);
  assert.match(independence, /Get-PathState -RelPath "\.tmp\\plugins" -RequiredLocalCopy \$true/);
  assert.match(independence, /Get-PathState -RelPath "computer-use" -RequiredLocalCopy \$true/);
  assert.doesNotMatch(independence, /AllowedSharedLink \$true/);
});

test("Anti-Codex ships a Codex host sync script", () => {
  const sync = readFileSync(resolve(root, "scripts", "sync-anticodex.ps1"), "utf8");
  const validator = readFileSync(resolve(root, "scripts", "test-anticodex-host-candidate.ps1"), "utf8");

  assert.match(sync, /install-anticodex\.ps1/);
  assert.match(sync, /test-anticodex-source-preflight\.ps1/);
  assert.match(sync, /\$global:LASTEXITCODE = 0[\s\S]{0,80}& \$sourcePreflight/);
  assert.match(sync, /\$global:LASTEXITCODE = 0[\s\S]{0,80}& \$installer/);
  assert.match(sync, /\$global:LASTEXITCODE = 0[\s\S]{0,80}& \$validator/);
  assert.match(sync, /source preflight failed\. Sync was stopped before building an update candidate/i);
  assert.match(sync, /-HostOnly/);
  assert.match(sync, /Split-Path -Parent \(Split-Path -Parent \$PSScriptRoot\)/);
  assert.match(sync, /test-anticodex-host-candidate\.ps1/);
  assert.match(sync, /update-candidate/);
  assert.match(sync, /rollback-host/);
  assert.match(sync, /AntiCodexHostSync/);
  assert.match(sync, /ANTICODEX_HOST_SYNC_MARKER/);
  assert.match(sync, /function Wait-AntiCodexHostRelease/);
  assert.match(sync, /start-anticodex\.ps1/);
  assert.match(sync, /Host sync marker/);
  assert.match(sync, /Start-Process/);
  assert.match(sync, /rollback-anticodex\.ps1/);
  assert.match(sync, /function Wait-AntiCodexPostSyncReady/);
  assert.match(sync, /function Invoke-AntiCodexPostSyncAcceptance/);
  assert.match(sync, /test-anticodex-installed-overall\.ps1/);
  assert.match(sync, /antigravity-desktop/);
  assert.match(sync, /Antigravity gateway ready/);
  assert.match(sync, /modelCount/);
  assert.doesNotMatch(sync, /Invoke-RestMethod -Uri "\$baseUrl\/anticodex\/diagnostics"/);
  assert.doesNotMatch(sync, /nativeBridgeDefaultEnabled/);
  assert.doesNotMatch(sync, /antigravitySessionLock/);
  assert.match(sync, /ANTICODEX_POST_SYNC_HEALTH_TIMEOUT_SEC/);
  assert.match(sync, /\$env:ANTICODEX_POST_SYNC_HEALTH_TIMEOUT_SEC/);
  assert.match(sync, /ANTICODEX_POSTSYNC_HEALTH_TIMEOUT_SEC/);
  assert.match(sync, /\$env:ANTICODEX_POSTSYNC_HEALTH_TIMEOUT_SEC/);
  assert.match(sync, /else\s*\{\s*8\s*\}/);
  assert.match(sync, /TimeoutSec \$ANTICODEX_POST_SYNC_HEALTH_TIMEOUT_SEC/);
  assert.doesNotMatch(sync, /TimeoutSec\s+3(?!\d)/);
  assert.match(sync, /Post-sync acceptance timed out/);
  assert.match(sync, /function Wait-AntiCodexChildProcess/);
  assert.match(sync, /\$Process\.HasExited/);
  assert.doesNotMatch(sync, /WaitForExit\(\$TimeoutSeconds \* 1000\)/);
  assert.doesNotMatch(sync, /Start-Process[\s\S]{0,260}\$postSyncVerifier/);
  assert.match(sync, /\$postSyncAcceptance\.ok -ne \$true/);
  assert.match(sync, /Automatic rollback restored the previous host/);
  assert.doesNotMatch(sync, /"-SkipUiStateProbe"/);
  assert.ok(
    sync.lastIndexOf("$syncMutex.ReleaseMutex()") > sync.indexOf("Invoke-AntiCodexPostSyncAcceptance -TimeoutSeconds 35"),
    "host sync mutex must remain held through post-sync acceptance and rollback",
  );
  assert.match(sync, /function Repair-RollbackHostIconManifest/);
  assert.match(sync, /assets\\anticodex\.ico/);
  assert.match(sync, /appRootIcon/);
  assert.match(sync, /trayIcon/);
  assert.match(sync, /resources\\codex-tray\.ico/);
  assert.match(sync, /Move-Item -LiteralPath \$temporaryMarker -Destination \$rollbackMarker -Force/);
  assert.match(sync, /Automatic rollback/);
  assert.match(sync, /\$activationStarted\s*=\s*\$false/);
  assert.match(sync, /\$activeHostChanged\s*=\s*\$false/);
  assert.match(sync, /\$rollbackAvailable\s*=\s*\$false/);
  assert.match(sync, /if\s*\(\$activationStarted\)/);
  assert.match(sync, /function Remove-FixedUpdateDirectory/);
  assert.match(sync, /\[IO\.Directory\]::Delete/);
  assert.match(sync, /function Move-FixedUpdateDirectory/);
  assert.match(sync, /\[IO\.Directory\]::Move/);
  assert.match(sync, /Candidate validation failed/);
  assert.match(sync, /catch\s*\{/);
  assert.match(validator, /codex-patched-app\.ok/);
  assert.match(validator, /resources\\app\.asar/);
  assert.match(validator, /resources\\codex\.exe/);
  assert.match(validator, /resources\\icon\.ico/);
  assert.match(validator, /resources\\codex-tray\.ico/);
  assert.match(validator, /hostIcon/);
  assert.match(validator, /appRootIcon/);
  assert.match(validator, /trayIcon/);
  assert.match(validator, /ProductName/);
  assert.match(validator, /Anti-Codex/);
  assert.match(validator, /--version/);
});

test("Anti-Codex ships a runtime-only sync script for source patches", () => {
  const runtimeSync = readFileSync(resolve(root, "scripts", "sync-anticodex-runtime.ps1"), "utf8");
  const installer = readFileSync(resolve(root, "scripts", "install-anticodex.ps1"), "utf8");
  const requiredRuntimeSourceFiles = new Set(extractQuotedListBlock(runtimeSync, "$requiredSourceFiles = @("));
  const installerRequiredRuntimeFiles = [...installer.matchAll(/\(Join-Path \$runtime "([^"]+)"\)/g)].map((match) => match[1]);

  assert.match(runtimeSync, /Anti-Codex\\runtime/);
  assert.match(runtimeSync, /translator\\antigravity-session-lock\.mjs/);
  assert.match(runtimeSync, /scripts\\test-anticodex-real-work\.ps1/);
  assert.match(runtimeSync, /scripts\\test-anticodex-real-mini-tool\.ps1/);
  assert.match(runtimeSync, /scripts\\test-anticodex-real-small-project\.ps1/);
  assert.match(runtimeSync, /scripts\\test-anticodex-model-switch-history\.ps1/);
  assert.match(runtimeSync, /Copy-AntiCodexRuntimeTree/);
  assert.match(runtimeSync, /robocopy\.exe/);
  assert.match(runtimeSync, /Remove-AntiCodexLegacyRuntimeFiles/);
  assert.match(runtimeSync, /Test-AntiCodexJavaScriptSyntax/);
  assert.match(runtimeSync, /--check/);
  assert.match(runtimeSync, /source translator\\adaptive-server\.mjs/);
  assert.match(runtimeSync, /runtime translator\\adaptive-server\.mjs/);
  assert.match(runtimeSync, /adaptive-server\.mjs/);
  assert.match(runtimeSync, /Refusing to remove Anti-Codex legacy runtime file outside/);
  assert.match(runtimeSync, /scripts\\start-anticodex\.ps1/);
  assert.match(runtimeSync, /start-deepcodex\.ps1/);
  assert.match(runtimeSync, /scripts\\anticodex-update-status\.psm1/);
  assert.match(runtimeSync, /scripts\\sync-anticodex\.ps1/);
  assert.match(runtimeSync, /scripts\\sync-anticodex-launcher\.ps1/);
  assert.match(runtimeSync, /scripts\\rollback-anticodex\.ps1/);
  assert.match(runtimeSync, /scripts\\rollback-anticodex-launcher\.ps1/);
  assert.match(runtimeSync, /scripts\\manage-anticodex\.ps1/);
  assert.match(runtimeSync, /scripts\\check-anticodex-update\.ps1/);
  assert.match(runtimeSync, /-TranslatorOnly/);
  assert.ok(installerRequiredRuntimeFiles.length >= 6, "installer runtime completeness list should be covered");
  for (const relative of installerRequiredRuntimeFiles) {
    assert.ok(
      requiredRuntimeSourceFiles.has(relative),
      `${relative} is required by install-anticodex.ps1 but missing from sync-anticodex-runtime.ps1 requiredSourceFiles`,
    );
  }
  assert.match(runtimeSync, /\$restartHealthy = \$false/);
  assert.match(runtimeSync, /Wait-AntiCodexHealth -Seconds 1/);
  assert.match(runtimeSync, /\$launchExitCode = if \(\$restartHealthy\) \{ 0 \}/);
  assert.match(runtimeSync, /Stop-AntiCodexTranslator/);
  assert.match(runtimeSync, /ANTICODEX_TRANSLATOR_RESTART_LOCK_OWNER/);
  assert.match(runtimeSync, /function Stop-ExtraAntiCodexTranslators/);
  assert.match(runtimeSync, /Stop-ExtraAntiCodexTranslators -KeepPid/);
  assert.match(runtimeSync, /stoppedExtraTranslatorCount/);
  assert.match(runtimeSync, /translator-restart\.lock/);
  assert.match(runtimeSync, /translatorRestartLockCreated/);
  assert.match(runtimeSync, /WriteAllText\(\$translatorRestartLockPath/);
  assert.match(runtimeSync, /Remove-Item -LiteralPath \$translatorRestartLockPath/);
  assert.match(runtimeSync, /\/anticodex\/diagnostics/);
  assert.match(runtimeSync, /Wait-AntiCodexSessionLock/);
  assert.match(runtimeSync, /diagnosticsTimeoutSec/);
  assert.doesNotMatch(runtimeSync, /Invoke-LocalJson "\/anticodex\/diagnostics" 5/);
  assert.match(runtimeSync, /Start-Sleep -Milliseconds 500/);
  assert.match(runtimeSync, /antigravitySessionLockPresent/);
  assert.doesNotMatch(runtimeSync, /codex-patched-app\\Anti-Codex\.exe/);
  assert.doesNotMatch(runtimeSync, /\/v1\/responses/);
});

test("Anti-Codex ships an opt-in real mini-tool task verifier", () => {
  const miniTool = readFileSync(resolve(root, "scripts", "test-anticodex-real-mini-tool.ps1"), "utf8");
  const realWork = readFileSync(resolve(root, "scripts", "test-anticodex-real-work.ps1"), "utf8");
  const realSmallProject = readFileSync(resolve(root, "scripts", "test-anticodex-real-small-project.ps1"), "utf8");
  const overall = readFileSync(resolve(root, "scripts", "test-anticodex-installed-overall.ps1"), "utf8");
  const postVerification = readFileSync(resolve(root, "scripts", "test-anticodex-post-verification.ps1"), "utf8");

  assert.match(miniTool, /\[switch\]\$AllowRealTraffic/);
  assert.match(miniTool, /if \(-not \$AllowRealTraffic\)/);
  assert.match(miniTool, /Enter-AntiCodexRealTrafficLock/);
  assert.match(miniTool, /\[System\.IO\.Path\]::GetTempPath\(\)/);
  assert.match(miniTool, /name\s*=\s*"create_mini_tool"/);
  assert.match(miniTool, /tool_choice\s*=\s*"required"/);
  assert.match(miniTool, /previous_response_id/);
  assert.match(miniTool, /function_call_output/);
  assert.match(miniTool, /\$cliSource\s*=\s*@"/);
  assert.match(miniTool, /\$cliResult\.lines\s+-ne\s+3/);
  assert.match(miniTool, /\$cliResult\.words\s+-ne\s+9/);
  assert.match(miniTool, /\$cliResult\.chars\s+-ne\s+53/);
  assert.match(miniTool, /请调用 create_mini_tool/);
  assert.match(miniTool, /\\u4e00-\\u9fff/);
  assert.match(miniTool, /reportName\s*=\s*"real-mini-tool"/);
  assert.match(miniTool, /requestedRealTraffic\s*=\s*\$true/);
  assert.match(miniTool, /usedRealTraffic\s*=\s*\$true/);
  assert.match(miniTool, /behaviorCovered\s*=\s*\(\$failures\.Count -eq 0\)/);
  assert.match(miniTool, /coverageKind\s*=\s*"real-traffic"/);
  assert.match(realWork, /请调用 create_probe_file/);
  assert.match(realWork, /\\u4e00-\\u9fff/);
  assert.match(realWork, /reportName\s*=\s*"real-work"/);
  assert.match(realWork, /requestedRealTraffic\s*=\s*\$true/);
  assert.match(realWork, /usedRealTraffic\s*=\s*\$true/);
  assert.match(realWork, /behaviorCovered\s*=\s*\(\$failures\.Count -eq 0\)/);
  assert.match(realWork, /coverageKind\s*=\s*"real-traffic"/);
  assert.match(realWork, /\$mcpExecution\s*=\s*Invoke-RealNodeReplMcpResult/);
  assert.match(realWork, /realMcp\s*=\s*\$mcpExecution/);
  assert.match(realWork, /MCP_OK/);
  assert.match(realSmallProject, /\[switch\]\$AllowRealTraffic/);
  assert.match(realSmallProject, /\[string\]\$Model/);
  assert.match(realSmallProject, /ANTICODEX_TEST_MODEL/);
  assert.match(realSmallProject, /claude-sonnet-4-6/);
  assert.match(realSmallProject, /if \(-not \$AllowRealTraffic\)/);
  assert.match(realSmallProject, /name\s*=\s*"write_small_project"/);
  assert.match(realSmallProject, /tool_choice\s*=\s*"required"/);
  assert.match(realSmallProject, /previous_response_id/);
  assert.match(realSmallProject, /function_call_output/);
  assert.match(realSmallProject, /Invoke-SafeSessionResetIfIdle/);
  assert.match(realSmallProject, /activeAntigravityRequests/);
  assert.match(realSmallProject, /resetAntigravitySessionLock/);
  assert.match(realSmallProject, /word-tally\.test\.mjs/);
  assert.match(realSmallProject, /node:test failed/);
  assert.match(realSmallProject, /CLI exited non-zero/);
  assert.match(realSmallProject, /reportName\s*=\s*"real-small-project"/);
  assert.match(realSmallProject, /coverageKind\s*=\s*"real-traffic-small-project"/);
  assert.match(miniTool, /\$finalText\s+-match\s+"DeepCodex"/);
  assert.match(realWork, /\$finalText\s+-match\s+"DeepCodex"/);
  assert.match(miniTool, /finally\s*\{[\s\S]*Remove-Item[\s\S]*Exit-AntiCodexRealTrafficLock/);
  assert.doesNotMatch(miniTool, /code\s*=\s*@\{/);
  assert.match(overall, /test-anticodex-real-mini-tool\.ps1/);
  assert.match(overall, /Real mini-tool task verification/);
  assert.match(overall, /\$NoTraffic -or \(-not \$AllowRealTraffic\)/);
  assert.match(overall, /test-anticodex-real-work\.ps1/);
  assert.match(overall, /Real work task verification/);
  assert.match(overall, /\$checks\.realWork/);
  assert.match(overall, /test-anticodex-real-small-project\.ps1/);
  assert.match(overall, /Real small-project task verification/);
  assert.match(overall, /\$checks\.realSmallProject/);
  assert.match(postVerification, /"-AllowRealTraffic"/);
});

test("Anti-Codex install and host sync refresh full local feature snapshots once", () => {
  const install = readFileSync(resolve(root, "scripts", "install-anticodex.ps1"), "utf8");
  const sync = readFileSync(resolve(root, "scripts", "sync-anticodex.ps1"), "utf8");

  assert.match(install, /sync-shared-codex-plugin-host\.mjs/);
  assert.match(install, /--local-snapshots/);
  assert.match(install, /optional full local feature snapshot needs a later Manager refresh/);
  assert.match(install, /codex-home-deepseek-app/);
  assert.match(sync, /refresh-anticodex-local-features\.ps1/);
  assert.match(sync, /local feature snapshot refresh needs a later Manager retry/);
});

test("Anti-Codex ships a safe one-click rollback script", () => {
  const rollback = readFileSync(resolve(root, "scripts", "rollback-anticodex.ps1"), "utf8");

  assert.match(rollback, /rollback-host/);
  assert.match(rollback, /rollback-host\.ok/);
  assert.match(rollback, /rollback-swap-host/);
  assert.match(rollback, /AntiCodexHostSync/);
  assert.match(rollback, /ANTICODEX_HOST_SYNC_MARKER/);
  assert.match(rollback, /function Test-AntiCodexHost/);
  assert.match(rollback, /anticodex-host-manifest-v1/);
  assert.match(rollback, /Get-FileHash/);
  assert.match(rollback, /resources\\icon\.ico/);
  assert.match(rollback, /appRootIcon/);
  assert.match(rollback, /function Wait-AntiCodexHostRelease/);
  assert.match(rollback, /function Wait-AntiCodexPostRollbackReady/);
  assert.match(rollback, /RecoveryAttempt/);
  assert.match(rollback, /start-anticodex\.ps1/);
  assert.match(rollback, /Automatic recovery/);
  assert.match(rollback, /Start-Process/);
});

test("Anti-Codex ships a single Start Menu manager for common maintenance actions", () => {
  const managerBytes = readFileSync(resolve(root, "scripts", "manage-anticodex.ps1"));
  const manager = readFileSync(resolve(root, "scripts", "manage-anticodex.ps1"), "utf8");
  const installer = readFileSync(resolve(root, "scripts", "install-anticodex.ps1"), "utf8");
  const readiness = readFileSync(resolve(root, "scripts", "test-anticodex-sync-readiness.ps1"), "utf8");
  const server = readFileSync(resolve(root, "translator", "adaptive-server.mjs"), "utf8");
  const inject = readFileSync(resolve(root, "scripts", "anticodex-manager-inject.js"), "utf8");
  const managerBridge = readFileSync(resolve(root, "scripts", "anticodex-manager-bridge.mjs"), "utf8");
  const managerAction = readFileSync(resolve(root, "scripts", "test-anticodex-manager-action.ps1"), "utf8");

  assert.deepEqual([...managerBytes.slice(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.match(manager, /System\.Windows\.Forms/);
  assert.match(manager, /ValidateSet\("Ui", "Status", "Window"\)/);
  assert.match(manager, /\[string\]\$Action = "Ui"/);
  assert.match(manager, /function Open-AntiCodexManagerPanel/);
  assert.match(manager, /ANTICODEX_MANAGER_API/);
  assert.match(manager, /anticodex-manager-inject\.js/);
  assert.match(manager, /anticodex-manager-open-inject\.js/);
  assert.match(manager, /latest native-panel-v99 manager script/);
  assert.doesNotMatch(manager, /native-panel-v92|native-panel-v91|native-panel-v90|native-panel-v89|native-panel-v88|native-panel-v68|native-panel-v56/);
  assert.match(manager, /function Start-EmbeddedManagerBridge/);
  assert.match(manager, /Test-EmbeddedManagerBridgeRunning -Port \$Port/);
  assert.match(manager, /PassThru/);
  assert.ok(
    manager.indexOf("anticodex-manager-inject.js") < manager.indexOf("anticodex-manager-open-inject.js"),
    "inject script must be loaded before the opener in the PS1 manager panel",
  );
  assert.match(manager, /installExitCode\s+-eq\s+0/);
  assert.doesNotMatch(manager, /installExitCode -eq 0 -and \$LASTEXITCODE -eq 0/);
  assert.match(manager, /--remote-debugging-port=\(\\d\+\)/);
  assert.doesNotMatch(manager, /function Use-ExistingAntiCodexManagerPage/);
  assert.doesNotMatch(manager, /\/json\/activate\/\$\(\$managerTarget\.id\)/);
  assert.doesNotMatch(manager, /Start-Process\s+\$managerUrl/);
  assert.match(manager, /start-anticodex\.ps1/);
  assert.match(manager, /function Get-ManagerHealthSnapshot/);
  assert.match(manager, /function Wait-ManagerHealth/);
  assert.match(manager, /function Start-AntiCodexGatewayAndWait/);
  assert.match(manager, /function Start-AntiCodexAndWait/);
  assert.match(manager, /function Stop-StaleEmbeddedManagerBridge/);
  assert.match(manager, /Test-EmbeddedManagerBridgeRunning[\s\S]*BaseUrl/);
  assert.match(manager, /--base-url\\s\+\$/);
  assert.match(manager, /Start-AntiCodexGatewayAndWait -BaseUrl \$baseUrl -TimeoutSeconds 25/);
  const statusFunction = manager.match(/function Get-ManagerStatus \{[\s\S]*?\n\}/)?.[0];
  assert.ok(statusFunction, "missing manager status function");
  assert.match(statusFunction, /Start-AntiCodexGatewayAndWait/);
  assert.doesNotMatch(statusFunction, /Start-AntiCodexAndWait|start-anticodex\.ps1/i);
  const gatewayStart = manager.indexOf("function Start-AntiCodexGatewayAndWait");
  const gatewayEnd = manager.indexOf("function Start-AntiCodexAndWait");
  const gatewayFunction = gatewayStart >= 0 && gatewayEnd > gatewayStart
    ? manager.slice(gatewayStart, gatewayEnd)
    : "";
  assert.ok(gatewayFunction, "missing manager gateway-only recovery function");
  assert.match(gatewayFunction, /start-deepcodex\.ps1/i);
  assert.match(gatewayFunction, /-TranslatorOnly/);
  assert.match(gatewayFunction, /ANTICODEX_NATIVE_TOOL_BRIDGE\s*=\s*["']0["']/i);
  assert.doesNotMatch(gatewayFunction, /ANTICODEX_NATIVE_TOOL_BRIDGE\s*=\s*["']1["']/i);
  assert.match(gatewayFunction, /DEEPCODEX_SKIP_PLUGIN_SYNC/);
  assert.doesNotMatch(gatewayFunction, /start-anticodex\.ps1/i);
  assert.match(manager, /antigravity-desktop\.ps1/);
  assert.match(manager, /refresh-anticodex-models\.ps1/);
  assert.match(manager, /switch-anticodex-account\.ps1/);
  assert.match(manager, /sync-anticodex-launcher\.ps1/);
  assert.match(manager, /rollback-anticodex-launcher\.ps1/);
  assert.match(manager, /test-anticodex-model-routing\.ps1/);
  assert.match(manager, /"-SkipRefresh", "-SkipRequests"/);
  assert.match(manager, /function Invoke-ReadOnlyModelCheck/);
  assert.match(manager, /AllowFailureJson/);
  assert.match(manager, /function Wait-AntiCodexManagerChildProcess/);
  assert.match(manager, /\$Process\.HasExited/);
  assert.match(manager, /\[void\]\$proc\.Handle/);
  assert.doesNotMatch(manager, /WaitForExit\(\$TimeoutMs\)/);
  assert.doesNotMatch(manager, /WaitForExit\(\$launchTimeoutMs\)/);
  assert.match(manager, /New-Object System\.Windows\.Forms\.TextBox/);
  assert.match(manager, /\$status\.Multiline = \$true/);
  assert.match(manager, /\$status\.ReadOnly = \$true/);
  assert.match(manager, /\$status\.ScrollBars = "Vertical"/);
  assert.match(manager, /accountTrafficReady/);
  assert.match(manager, /accountTrafficDiagnosis/);
  assert.match(manager, /accountTrafficModel/);
  assert.match(manager, /accountTrafficSuggestedAction/);
  assert.match(manager, /\$trafficDiagnosis/);
  assert.match(manager, /quota_or_limit_reached/);
  assert.match(manager, /antigravity_quota_exceeded/);
  assert.match(manager, /account_verification_required/);
  assert.match(manager, /account_verification_with_missing_token/);
  assert.match(manager, /collect-anticodex-diagnostics\.ps1/);
  assert.match(manager, /function Invoke-DiagnosticBundleCollection/);
  assert.match(manager, /model-routing-refresh\.json/);
  assert.match(manager, /TimeoutMs 90000/);
  assert.match(manager, /function Invoke-AccountProxyCheck/);
  assert.match(manager, /test-anticodex-account-proxy-readiness\.ps1/);
  assert.match(manager, /-AllowUnready/);
  assert.match(manager, /function Format-AccountPhaseSummary/);
  assert.match(manager, /phaseSummary/);
  assert.match(manager, /\$result\.models\.selected/);
  assert.match(manager, /function Invoke-InstallSyncCheck/);
  assert.match(manager, /test-anticodex-sync-readiness\.ps1/);
  assert.match(manager, /Invoke-ManagerScriptJson "test-anticodex-sync-readiness\.ps1" -Arguments @\("-Fast", "-SkipAccountProxyProbe"\) -TimeoutMs 30000/);
  assert.match(manager, /function Invoke-UiStateCheck/);
  assert.match(manager, /test-anticodex-ui-state\.ps1/);
  assert.match(manager, /ECONNREFUSED\|connection refused\|refused\|connect/);
  assert.match(manager, /function Invoke-McpSkillsCheck/);
  assert.match(manager, /test-anticodex-mcp-skills\.ps1/);
  assert.match(manager, /function Test-OnlyGatewayFailures/);
  assert.match(manager, /function Invoke-PluginCapabilityCheck/);
  assert.match(manager, /test-anticodex-plugin-capabilities\.ps1/);
  assert.match(manager, /\/anticodex\/diagnostics/);
  assert.match(manager, /antigravityQueue/);
  assert.match(manager, /accountTracking/);
  assert.match(manager, /function Invoke-LocalFeatureRefresh/);
  assert.match(manager, /refresh-anticodex-local-features\.ps1/);
  assert.match(manager, /TimeoutMs 300000/);
  assert.match(manager, /function Invoke-OverallNoTrafficCheck/);
  assert.match(manager, /test-anticodex-installed-overall\.ps1/);
  assert.match(manager, /-EnsureRunning/);
  assert.match(manager, /-NoTraffic/);
  assert.match(manager, /function Start-PostVerificationFullCheck/);
  assert.match(manager, /function Get-PostVerificationStatusLine/);
  assert.match(manager, /function Get-PostVerificationProcesses/);
  assert.match(manager, /test-anticodex-post-verification\.ps1/);
  assert.match(manager, /-OpenAntigravityOnVerification/);
  assert.match(manager, /latest-post-verification\.json/);
  assert.match(manager, /diagnosisDetail/);
  assert.match(manager, /\/health/);
  assert.match(manager, /\/anticodex\/account/);
  assert.match(manager, /function Get-CachedUpdateNeeded/);
  assert.match(manager, /update-status\.json/);
  assert.match(manager, /Diagnostics\.updateStatus/);
  assert.doesNotMatch(manager, /check-anticodex-update\.ps1[\s\S]*-NoPersist/);
  assert.doesNotMatch(manager, /chatgpt\.com|auth\/login/);
  assert.match(server, /function anticodexManagerHtml/);
  assert.match(server, /function latestPostVerificationStatus/);
  assert.match(server, /translator-lifecycle\.json/);
  assert.match(server, /translator-lifecycle\.jsonl/);
  assert.match(server, /function writeLifecycleEvent/);
  assert.match(server, /function trimLifecycleLog/);
  assert.match(server, /ANTICODEX_LIFECYCLE_LOG_MAX_BYTES/);
  assert.match(server, /ANTICODEX_LIFECYCLE_LOG_MAX_LINES/);
  assert.match(server, /function latestLifecycleStatus/);
  assert.match(server, /safeErrorSummary/);
  assert.match(server, /startup_readiness_degraded/);
  assert.match(server, /startup_ready/);
  assert.match(server, /uncaught_exception/);
  assert.match(server, /unhandled_rejection/);
  assert.match(server, /server_error/);
  assert.match(server, /MANAGER_ACTIONS/);
  assert.match(server, /MANAGER_ACTION_TOKEN/);
  assert.match(server, /x-anticodex-manager-token/);
  assert.match(server, /function validateManagerActionRequest/);
  assert.match(server, /function isTrustedManagerOriginValue/);
  assert.match(server, /req\.headers\.origin/);
  assert.match(server, /req\.headers\.referer/);
  assert.match(server, /function managerScriptPath/);
  assert.match(server, /relativePath\(MANAGER_SCRIPTS_ROOT, scriptPath\)/);
  assert.match(server, /updateCheck/);
  assert.match(server, /check-anticodex-update\.ps1/);
  assert.match(server, /refreshFeatures/);
  assert.match(server, /refresh-anticodex-local-features\.ps1/);
  assert.match(server, /refreshFeatures:\s*\{[\s\S]*?background:\s*true/);
  assert.match(server, /refreshFeatures:\s*\{[\s\S]*?singletonProcessPattern:\s*"refresh-anticodex-local-features\\\\\.ps1"/);
  assert.match(server, /stabilitySoak/);
  assert.match(server, /test-anticodex-stability-soak\.ps1/);
  assert.match(server, /stabilitySoak:\s*\{[\s\S]*?background:\s*true/);
  assert.match(server, /stabilitySoak:\s*\{[\s\S]*?singletonProcessPattern:\s*"test-anticodex-stability-soak\\\\\.ps1"/);
  assert.match(server, /coldRelaunch/);
  assert.match(server, /test-anticodex-cold-relaunch\.ps1/);
  assert.match(server, /coldRelaunch:\s*\{[\s\S]*?args:\s*\["-ConfirmRelaunch"\]/);
  assert.match(server, /coldRelaunch:\s*\{[\s\S]*?background:\s*true/);
  assert.match(server, /coldRelaunch:\s*\{[\s\S]*?singletonProcessPattern:\s*"test-anticodex-cold-relaunch\\\\\.ps1"/);
  assert.match(server, /syncHost/);
  assert.match(server, /sync-anticodex-launcher\.ps1/);
  assert.match(server, /singletonProcessPattern/);
  assert.match(server, /MANAGER_ACTION_LOCKS/);
  assert.match(server, /MANAGER_BACKGROUND_ACTIONS/);
  assert.match(server, /MANAGER_FOREGROUND_ACTIONS/);
  assert.match(server, /foregroundSingleton:\s*true/);
  assert.match(server, /function managerForegroundActionKey/);
  assert.match(server, /function managerForegroundActionItems/);
  assert.match(server, /\[\.\.\.managerForegroundActionItems\(\),\s*\.\.\.managerBackgroundActionItems\(\)\]/);
  assert.match(server, /stage:\s*"manager_foreground"/);
  assert.match(server, /foregroundStartedAt/);
  assert.match(server, /function managerBackgroundActionItems/);
  assert.match(server, /backgroundStartedAt/);
  assert.match(server, /otherRunningItems=items\.filter/);
  assert.match(server, /backgroundLockMaxMs/);
  assert.match(server, /function managerActionRunningProcesses/);
  assert.match(server, /alreadyRunning/);
  assert.match(server, /payload\?\.foreground\s*&&\s*payload\?\.alreadyRunning/);
  assert.match(server, /foregroundStartedAt\|\|"\\u672a\\u77e5"/);
  assert.match(server, /"\\u5df2\\u7ecf\\u5728\\u8fd0\\u884c"/);
  assert.match(server, /runningPids/);
  assert.match(server, /runManagerAction/);
  assert.match(server, /\/anticodex\/manager\/action/);
  assert.match(server, /unwrapped\.diagnosticsSummary\?\.longTasks/);
  assert.match(server, /otherRunningItems\?\.length/);
  assert.match(inject, /unwrapped\.diagnosticsSummary\?\.longTasks/);
  assert.match(managerBridge, /unwrappedResult\.diagnosticsSummary\?\.longTasks/);
  assert.match(managerAction, /\/anticodex\/manager/);
  assert.match(managerAction, /\/anticodex\/manager\/action/);
  assert.match(managerAction, /x-anticodex-manager-token/);
  assert.match(managerAction, /http:\/\/evil\.example/);
  assert.match(managerAction, /"Origin"\s*=\s*"null"/);
  assert.match(managerAction, /nullOriginStatus/);
  assert.match(server, /String\(value\)\.toLowerCase\(\) === "null"\)\s*return false/);
  assert.match(managerAction, /Access-Control-Allow-Origin/);
  assert.match(managerAction, /Unknown Anti-Codex manager action/);
  assert.match(managerAction, /requiredManagerActions/);
  assert.match(managerAction, /data-manager-action="/);
  assert.match(managerAction, /accountProxy/);
  assert.match(managerAction, /syncReadiness/);
  assert.match(managerAction, /repairShortcuts/);
  assert.match(managerAction, /mcpSkills/);
  assert.match(managerAction, /pluginCapabilities/);
  assert.match(managerAction, /sourcePreflight/);
  assert.match(managerAction, /resetAntigravitySessionLock/);
  assert.match(managerAction, /stabilitySoak/);
  assert.match(managerAction, /coldRelaunch/);
  assert.match(managerAction, /fastOverallNoTraffic/);
  assert.match(managerAction, /document\\\.querySelectorAll\\\("button\\\[data-action\\\]"\\\)/);
  assert.match(managerAction, /setActionButtonsDisabled\\\(true\\\)/);
  assert.match(managerAction, /setActionButtonsDisabled\\\(false\\\)/);
  assert.match(managerAction, /id="actionResult"/);
  assert.match(managerAction, /<html lang="zh-CN"/);
  assert.match(managerAction, /window\\\.open\|target=/);
  assert.match(managerAction, /<iframe\\b/);
  assert.match(managerAction, /actionNames/);
  assert.match(managerAction, /hasButtonClickBinding/);
  assert.match(managerAction, /hasDisableReenable/);
  assert.match(managerAction, /hasNoLoginNoTrafficNotice/);
  assert.match(managerAction, /hasRouteProviderFields/);
  assert.match(managerAction, /manager page route summary is missing third-party provider\/protocol\/transport fields/);
  assert.match(managerAction, /\/anticodex\/model-routes/);
  assert.match(managerAction, /providerProtocol/);
  assert.match(managerAction, /hasAdaptiveTheme/);
  assert.match(managerAction, /prefers-color-scheme:light/);
  assert.match(managerAction, /\[switch\]\$RunSafeAction/);
  assert.match(managerAction, /\$SafeActionName = "refreshStatus"/);
  assert.match(managerAction, /\[switch\]\$RunUpdateCheckAction/);
  assert.match(managerAction, /safeActionName/);
  assert.match(managerAction, /refreshStatus/);
  assert.match(managerAction, /updateCheck/);
  assert.match(managerAction, /updateCheckRan/);
  assert.match(managerAction, /\[switch\]\$RunSessionResetAction/);
  assert.match(managerAction, /sessionReset/);
  assert.match(managerAction, /activeReleased/);
  assert.match(managerAction, /queuedCancelled/);
  assert.match(managerAction, /activeAntigravityRequests/);
  assert.match(server, /resetAntigravityProcessManagerState/);
  assert.match(server, /process_manager/);
  assert.match(server, /chat_processes\.json/);
  assert.match(server, /before-reset-/);
  assert.match(managerAction, /\$activeRequestCount\s*=\s*\[int\]\$diagnostics\.activeAntigravityRequests\.active/);
  assert.match(managerAction, /\$canResetStaleLock\s*=\s*\$true/);
  assert.match(managerAction, /resetMode\s*=\s*if \(\$isIdle\) \{ "idle" \} else \{ "stale-lock" \}/);
  assert.match(managerAction, /Session lock is not safe to reset/);
  assert.match(managerAction, /"Origin"\s*=\s*\$BaseUrl[\s\S]{0,120}"Referer"\s*=\s*"\$BaseUrl\/anticodex\/manager"/);
  assert.doesNotMatch(managerAction, /\$SafeActionName\s*=\s*"(?:postVerificationFull|syncHost|stabilitySoak|coldRelaunch)"/);
  assert.doesNotMatch(managerAction, /-Body\s+'\{"action":"(?:postVerificationFull|syncHost|stabilitySoak|coldRelaunch)"/);
  assert.match(server, /postVerification/);
  assert.match(server, /function localFeatureSummary/);
  assert.match(server, /localFeatures/);
  assert.match(server, /installedChecks/);
  assert.match(server, /longTasks/);
  assert.match(server, /function longTaskSummary/);
  assert.match(server, /function longTaskRows/);
  assert.match(inject, /manager_foreground/);
  assert.match(inject, /otherRunningItems\s*=\s*items\.filter/);
  assert.match(server, /id="copyActionResult"/);
  assert.match(server, /function copyTextToClipboard/);
  assert.match(server, /id="snapshotAlert"/);
  assert.match(server, /function renderSnapshotAlert/);
  assert.match(server, /source_changed/);
  assert.match(server, /latestLogLine/);
  assert.match(server, /logAgeMs/);
  assert.match(server, /escapeHtml/);
  assert.match(server, /id="longTasks"/);
  assert.match(server, /shortcutRepair/);
  assert.match(server, /latest-installed-overall-fast\.json/);
  assert.match(server, /latest-shortcut-repair\.json/);
  assert.match(server, /id="localChecks"/);
  assert.match(server, /latest-post-verification\.json/);
  assert.match(server, /id="postVerification"/);
  assert.match(server, /const postState=/);
  assert.match(server, /\/anticodex\/manager/);
  assert.doesNotMatch(server, /function htmlResponse[\s\S]{0,350}access-control-allow-origin/);
  assert.match(server, /accountTrafficDiagnosis\|\|health\.accountTrafficState\|\|health\.accountState/);
  assert.doesNotMatch(server, /\/anticodex\/manager\/open/);
  assert.doesNotMatch(server, /openAntiCodexManagerTarget/);
  assert.match(server, /lf=diag\.localFeatures/);
  assert.match(server, /Skill/);
  assert.match(server, /MCP/);
  assert.match(server, /quota_or_limit_reached/);
  assert.match(server, /accountTrafficModel/);
  assert.match(server, /accountTrafficSuggestedAction/);
  assert.match(server, /id="plugins"/);
  assert.match(server, /function syncVersion/);
  assert.match(server, /function syncSafetyText/);
  assert.match(server, /test-anticodex-account-proxy-readiness\.ps1/);
  assert.match(server, /test-anticodex-sync-readiness\.ps1/);
  assert.match(server, /repairShortcuts:[\s\S]{0,180}repair-anticodex-shortcuts\.ps1/);
  assert.match(server, /repairShortcuts:[\s\S]{0,220}timeoutMs:\s*30_000/);
  assert.match(server, /syncReadiness:[\s\S]{0,180}args:\s*\["-Fast",\s*"-SkipAccountProxyProbe"\]/);
  assert.match(server, /syncReadiness:[\s\S]{0,220}timeoutMs:\s*30_000/);
  assert.match(server, /test-anticodex-mcp-skills\.ps1/);
  assert.match(server, /test-anticodex-plugin-capabilities\.ps1/);
  assert.match(server, /\/backend-api\/ps\/plugins\/installed/);
  assert.match(server, /\/backend-api\/plugins\/list/);
  assert.match(server, /\/backend-api\/aip\/connectors/);
  assert.match(server, /\/backend-api\/wham\/apps/);
  assert.match(server, /\/anticodex\/local-connectors\/allowlist/);
  assert.match(server, /localConnectorAllowlistPayload/);
  assert.match(server, /validateLocalConnectorIds/);
  assert.match(server, /writePersistedLocalConnectorAllowlist/);
  assert.match(server, /local_authorized_connectors/);
  assert.match(server, /localAllowlisted/);
  assert.match(server, /validateManagerSourceRequest\(req,\s*"local connector allowlist"\)/);
  assert.match(server, /validateManagerActionRequest\(req\)/);
  assert.match(server, /id="connectorAllowlist"/);
  assert.match(server, /id="connectorAllowlistInput"/);
  assert.match(server, /id="saveConnectorAllowlist"/);
  assert.match(server, /renderConnectorAllowlist/);
  assert.match(server, /x-anticodex-manager-token/);
  assert.match(inject, /optionalLoadErrors/);
  assert.match(inject, /\\u5e94\\u7528\\u5de5\\u5177\\u6682\\u4e0d\\u53ef\\u8bfb/);
  assert.doesNotMatch(inject, /\[appToolsResult,[\s\S]{0,80}item\.error\?\.message/);
  assert.match(server, /test-anticodex-installed-overall\.ps1/);
  assert.match(server, /fastOverallNoTraffic:\s*"[^"]+"/);
  assert.match(server, /sourcePreflight:\s*"[^"]+"/);
  assert.match(server, /data-action="sourcePreflight"/);
  assert.match(server, /test-anticodex-source-preflight\.ps1/);
  assert.match(server, /"-SkipFullRegression"/);
  assert.match(server, /data-action="fastOverallNoTraffic"/);
  assert.doesNotMatch(server, /fastOverallNoTraffic:[\s\S]{0,320}"-SkipUiStateProbe"/);
  assert.match(server, /fastOverallNoTraffic:[\s\S]{0,320}"-SubcheckTimeoutSec",\s*"30"/);
  assert.match(server, /fastOverallNoTraffic:[\s\S]{0,360}"-FastMaxElapsedMs",\s*"90000"/);
  assert.match(server, /overallNoTraffic:[\s\S]{0,260}"-SkipUiStateProbe"/);
  assert.match(server, /function reportSummaryLines/);
  assert.match(server, /function failureSummaryLine/);
  assert.match(server, /function localGatewayGuidanceLine/);
  assert.match(server, /local Anti-Codex gateway is offline/);
  assert.match(server, /viewLatestReports/);
  assert.match(server, /function latestManagerReportsPayload/);
  assert.match(server, /publicDocumentationOk: fileName === "latest-source-preflight\.json"/);
  assert.match(server, /sourcePreflightEvidence/);
  assert.match(server, /upstreamProfileStorageOk/);
  assert.match(server, /antigravityCliIsolationProfileOk/);
  assert.match(server, /antigravityCliProfilePrepareOk/);
  assert.match(server, /antigravityCliWindowsUserLoginDryRunOk/);
  assert.match(server, /antigravityCliWindowsUserLoginDryRunContract/);
  assert.match(server, /sourcePreflight windowsUserLogin:/);
  assert.match(server, /sourcePreflight windowsUserLogin readiness:/);
  assert.match(server, /sourcePreflight profilePrepare: traffic=/);
  assert.match(server, /sourcePreflight profilePrepare caveat:/);
  assert.match(server, /localConnectorVerifierOk/);
  assert.match(server, /publicDocumentationClientCopySyncContractOk/);
  assert.match(server, /client-copy-sync-contract/);
  assert.match(server, /sourcePreflight: js=/);
  assert.match(server, /cliIsolation=/);
  assert.match(server, /prepare=/);
  assert.match(server, /clientCopyDocs=/);
  assert.match(server, /publicDocumentationFailureCount: fileName === "latest-source-preflight\.json"/);
  assert.match(server, /localConnectorEvidence/);
  assert.match(server, /modelRoutingEvidence/);
  assert.match(server, /modelRouting: mode=/);
  assert.match(server, /mcpSkillEvidence/);
  assert.match(server, /mcpMissingSharedCount/);
  assert.match(server, /mcpMissingSharedSample/);
  assert.match(server, /mcpExtraLocalSample/);
  assert.match(server, /mcpChangedSharedCount/);
  assert.match(server, /missingSharedSkillSample/);
  assert.match(server, /extraLocalSkillSample/);
  assert.match(server, /conflictingDuplicateSkillCount/);
  assert.match(server, /expectedSharedSkillCount/);
  assert.match(server, /mcpRealCallPassed/);
  assert.match(server, /mcpRealListCount/);
  assert.match(server, /mcpRealListPassed/);
  assert.match(server, /mcpRealListToolCount/);
  assert.match(server, /list "\+\(evidence\.mcpRealListPassed/);
  assert.match(server, /appToolRegistryExists/);
  assert.match(server, /appToolRegistryContentMatches/);
  assert.match(server, /appToolRegistryFingerprintMatches/);
  assert.match(server, /MCP\/Skill parity/);
  assert.match(server, /app-tool registry:/);
  assert.match(server, /\/ real /);
  assert.match(server, /MCP missing:/);
  assert.match(server, /MCP extra:/);
  assert.match(server, /MCP changed:/);
  assert.match(server, /skill missing:/);
  assert.match(server, /skill extra:/);
  assert.match(server, /skill duplicate conflicts:/);
  assert.match(server, /refreshFeatureEvidence/);
  assert.match(server, /verifyOnly:\s*report\?\.verifyOnly === true/);
  assert.match(server, /elapsedMs:\s*Number\.isFinite/);
  assert.match(server, /hashCacheHitCount/);
  assert.match(server, /hashCacheMissCount/);
  assert.match(server, /hashCacheEntryCount/);
  assert.match(server, /accountProxyEvidence/);
  assert.match(server, /accountProxy: detail=/);
  assert.match(server, /accountProxy phase: account=/);
  assert.match(server, /accountProxy logs: source=/);
  assert.match(server, /refresh parity:/);
  assert.match(server, /refresh timing:/);
  assert.match(server, /refresh drift:/);
  assert.match(server, /refresh recovery:/);
  assert.match(server, /recoveryActionIds/);
  assert.match(server, /recoveryActions: "\+recoveryActionIds\.join/);
  assert.match(server, /optionalRealProviderEvidence/);
  assert.match(server, /realProviderToAntigravityReturnEvidence/);
  assert.match(server, /antigravityReturnEvidence/);
  assert.match(server, /realProviderSmoke: first=/);
  assert.match(server, /realProviderToAntigravityReturn: requested=/);
  assert.match(server, /realProviderToAntigravityRoute:/);
  assert.match(server, /redaction=/);
  assert.match(server, /fakeProviderToAntigravityReturn: history=/);
  assert.match(server, /fakeProviderToAntigravityRoute:/);
  assert.match(server, /pluginCapabilityEvidence/);
  assert.match(server, /logDbGuardEvidence/);
  assert.match(server, /logDbGuard: protected=/);
  assert.match(server, /antigravityCliRealSmoke: login=/);
  assert.match(server, /antigravityCliRealSmoke caveat:/);
  assert.match(server, /antigravityCliRealSmoke lane: role=/);
  assert.match(server, /antigravityCliRealSmoke lane:.*mcpManagedHere=/);
  assert.match(server, /antigravityCliRealSmoke lane:.*mcpOwner=/);
  assert.match(server, /antigravityCliRealSmoke identity: antiCodexId=/);
  assert.match(server, /antigravityCliRealSmoke identity:.*distinct=/);
  assert.match(server, /antigravityCliProfilePrepare: separateAccount=/);
  assert.match(server, /antigravityCliProfilePrepare caveat:/);
  assert.match(server, /connectorParityMissingSharedSample/);
  assert.match(server, /connectorParityExtraLocalSample/);
  assert.match(server, /connectorParityChangedSharedSample/);
  assert.match(server, /appToolParityExtraLocalSample/);
  assert.match(server, /appToolGetPostMissingFromGetSample/);
  assert.match(server, /appToolGetPostExtraFromGetSample/);
  assert.match(server, /parity drift: connectorMissing=/);
  assert.match(server, /connectorExtra=/);
  assert.match(server, /connectorChanged=/);
  assert.match(server, /appToolExtra=/);
  assert.match(server, /getPostExtra=/);
  assert.match(server, /upstreamRequestsDuringLocalEndpoints/);
  assert.match(server, /local connector parity:/);
  assert.match(server, /appToolGetPostExtraFromGet/);
  assert.match(server, /unauthorizedAppToolCount/);
  assert.match(server, /appToolGetPostParityClean/);
  assert.match(server, /appToolGetPostParityContentMatches/);
  assert.match(server, /releaseGateFailures/);
  assert.match(server, /reason: shortSafeText\(action\.reason/);
  assert.match(server, /guidance: shortSafeText\(action\.guidance/);
  assert.match(server, /rawReleaseGateGroups/);
  assert.match(server, /report\?\.releaseGateGroups/);
  assert.match(server, /report\?\.releaseGateSelectedReports/);
  assert.match(server, /installedRuntimeEvidence/);
  assert.match(server, /releaseGateSelectedReports/);
  assert.match(server, /releaseGateFailureReasons/);
  assert.match(server, /historySourceMismatch/);
  assert.match(server, /releaseGateFailureReasons[\s\S]*slice\(0, 64\)/);
  assert.match(server, /actionReasons: /);
  assert.match(server, /actionGuidance: /);
  assert.match(server, /installedRuntime: satisfied=/);
  assert.match(server, /files=/);
  assert.match(server, /sourceMtime=/);
  assert.match(server, /installedRuntime drift:/);
  assert.match(server, /semanticFailures/);
  assert.match(server, /requestedRealTraffic/);
  assert.match(server, /coverageKind/);
  assert.match(server, /skipped: /);
  assert.match(managerBridge, /skipped: /);
  assert.match(managerBridge, /requestedRealTraffic=/);
  assert.match(managerBridge, /coverage=/);
  assert.match(server, /providerContinuity/);
  assert.match(server, /restartPreservesOpenAiToolPair/);
  assert.match(server, /markerThresholdsOk/);
  assert.match(server, /previousResponseContinuity/);
  assert.match(server, /previousResponseIdChain/);
  assert.match(server, /saveMatched/);
  assert.match(server, /providerSwitchMatchesNested/);
  assert.match(server, /previousIds: save=/);
  assert.match(server, /previousMatches: save=/);
  assert.match(server, /nestedMatches: provider=/);
  assert.match(server, /previousChain: save=/);
  assert.match(server, /sixthMarkerCount/);
  assert.match(server, /sixthOrderedHistoryCount/);
  assert.match(server, /providerContinuity: turns=/);
  assert.match(server, /latest-codex-responses\.json/);
  assert.match(server, /latest-real-work\.json/);
  assert.match(server, /latest-real-small-project\.json/);
  assert.match(server, /latest-native-tool-loop\.json/);
  assert.match(server, /latest-native-multi-tool-loop\.json/);
  assert.match(server, /latest-mcp-tool-loop\.json/);
  assert.match(server, /latest-custom-tool-loop\.json/);
  assert.match(server, /latest-web-tools\.json/);
  assert.match(server, /latest-cancellation\.json/);
  assert.match(server, /latest-mcp-skills\.json/);
  assert.match(server, /latest-plugin-capabilities\.json/);
  assert.match(server, /latest-local-connectors\.json/);
  assert.match(server, /latest-sync-readiness\.json/);
  assert.match(server, /latest-tool-bridge-mode\.json/);
  assert.match(server, /latest-ui-idle-stability\.json/);
  assert.match(server, /latest-model-routing\.json/);
  assert.match(server, /latest-model-thinking\.json/);
  assert.match(server, /latest-third-party-provider\.json/);
  assert.match(server, /latest-release-gates\.json/);
  assert.match(server, /latest-cold-relaunch\.json/);
  assert.match(server, /latest-manager-real-buttons\.json/);
  assert.match(server, /latest-refresh-features\.json/);
  assert.match(server, /latest-diagnostics\.json/);
  assert.match(server, /latest-shortcut-repair\.json/);
  assert.match(server, /latest-compaction-resume\.json/);
  assert.match(server, /latest-stability-soak\.json/);
  assert.match(server, /latest-account-proxy-readiness\.json/);
  assert.match(server, /latest-real-third-party-provider\.json/);
  assert.match(server, /latest-provider-antigravity-return\.json/);
  assert.match(server, /latestReportsSummary/);
  assert.match(server, /ensureLatestReportsEvidenceLines/);
  assert.match(inject, /ensureLatestReportsEvidenceLines/);
  assert.match(inject, /__ANTICODEX_MANAGER_SUMMARY_VERSION__/);
  assert.ok(server.includes("\\\\u516c\\\\u5f00\\\\u6587\\\\u6863\\\\uff1a") || server.includes("\\u516c\\u5f00\\u6587\\u6863\\uff1a") || server.includes("公开文档"));
  assert.ok(inject.includes("\\\\u516c\\\\u5f00\\\\u6587\\\\u6863\\\\uff1a") || inject.includes("\\u516c\\u5f00\\u6587\\u6863\\uff1a") || inject.includes("公开文档"));
  assert.ok(managerBridge.includes("\\\\u516c\\\\u5f00\\\\u6587\\\\u6863\\\\uff1a") || managerBridge.includes("\\u516c\\u5f00\\u6587\\u6863\\uff1a") || managerBridge.includes("公开文档"));
  assert.match(server, /function readJsonReportIfPresent/);
  assert.match(server, /function reportIntegrityForPath/);
  assert.match(server, /\.sha256/);
  assert.match(server, /createHash\("sha256"\)/);
  assert.match(server, /invalid_report/);
  assert.match(server, /invalid_report_integrity/);
  assert.match(server, /integrity_hash/);
  assert.match(server, /hash_mismatch/);
  assert.match(server, /missingCount/);
  assert.match(server, /missingOptional/);
  assert.match(server, /invalidCount/);
  assert.match(server, /parseable/);
  assert.match(server, /parseError/);
  assert.match(server, /parseErrorType/);
  assert.match(server, /missingReason/);
  assert.match(server, /report parse failed/);
  assert.match(managerBridge, /result\.missingCount/);
  assert.match(managerBridge, /result\.invalidCount/);
  assert.match(server, /if\(item\.exists&&item\.latestPath\)/);
  assert.match(server, /const reset=r\.result\|\|r/);
  assert.match(server, /ageMs/);
  assert.match(server, /function formatReportAge/);
  assert.match(server, /MANAGER_REPORT_STALE_MS/);
  assert.match(server, /staleCount/);
  assert.match(server, /\\\\u6700\\\\u65b0\\\\u62a5\\\\u544a/);
  assert.match(server, /\\\\u5386\\\\u53f2\\\\u62a5\\\\u544a/);
  assert.match(server, /\\\\u5931\\\\u8d25\\\\u9879/);
  assert.doesNotMatch(server, /if\(false&&payload\?\.action===/);
  assert.match(manager, /Invoke-ManagerScriptJson "test-anticodex-installed-overall\.ps1" -Arguments @\("-EnsureRunning", "-NoTraffic", "-SkipAccountProxyProbe", "-SkipManagerActionProbe"\)/);
  assert.match(server, /collect-anticodex-diagnostics\.ps1/);
  assert.match(server, /test-anticodex-post-verification\.ps1/);
  assert.match(server, /background: true/);
  assert.match(server, /-NoPopup/);
  assert.match(installer, /Manage Anti-Codex\.lnk/);
  assert.match(installer, /manage-anticodex\.ps1/);
  assert.match(readiness, /Manage Anti-Codex\.lnk/);
  assert.match(readiness, /startMenuManagerShortcutExists/);
  assert.match(readiness, /Test-ShortcutIconLocation/);
  assert.match(readiness, /expectedShortcutIconLocation/);
  assert.match(readiness, /IconLocation/);
  assert.match(readiness, /verified Anti-Codex icon/);
  assert.match(readiness, /desktopMainShortcutIconLocation/);
  assert.match(readiness, /desktopShortcutIconPalette/);
  assert.match(readiness, /startMenuMainShortcutIconLocation/);
  assert.match(readiness, /startMenuSyncShortcutIconLocation/);
  assert.match(readiness, /startMenuRollbackShortcutIconLocation/);
  assert.match(readiness, /startMenuManagerShortcutIconLocation/);
});

test("Anti-Codex ships a post-verification real-traffic verifier", () => {
  const script = readFileSync(resolve(root, "scripts", "test-anticodex-post-verification.ps1"), "utf8");

  assert.match(script, /test-anticodex-account-proxy-readiness\.ps1/);
  assert.match(script, /test-anticodex-installed-overall\.ps1/);
  assert.match(script, /Invoke-AntiCodexHealth/);
  assert.match(script, /Resolve-AntiCodexMode/);
  assert.match(script, /Test-AntiCodexPostVerificationReady/);
  assert.match(script, /upstreamProfile\.model/);
  assert.match(script, /third-party/);
  assert.match(script, /provider_ready/);
  assert.match(script, /third-party mode skips Antigravity account\/proxy wait/);
  assert.match(script, /-AllowUnready/);
  assert.match(script, /latestDiagnosis/);
  assert.match(script, /usedRealTraffic = \$true/);
  assert.match(script, /function Save-Progress/);
  assert.match(script, /post-verification\.lock/);
  assert.match(script, /\[IO\.File\]::Open/);
  assert.match(script, /\[IO\.FileShare\]::None/);
  assert.match(script, /already_running/);
  assert.match(script, /function Remove-OldReports/);
  assert.match(script, /Select-Object -Skip \$Keep/);
  assert.match(script, /waiting_for_account/);
  assert.match(script, /waiting_for_provider/);
  assert.match(script, /running_full_verification/);
  assert.match(script, /state = if/);
  assert.match(script, /OpenAntigravityOnVerification/);
  assert.match(script, /\$upstreamMode -eq "antigravity"/);
  assert.match(script, /resolve-anticodex-base-url\.ps1/);
  assert.match(script, /post-verification/);
  assert.match(script, /if \(\$ready\)/);
  assert.match(script, /-EnsureRunning/);
  assert.doesNotMatch(script, /-NoTraffic/);
});

test("Anti-Codex optional Antigravity CLI real-smoke carries account lane boundary fields", () => {
  const smoke = readFileSync(resolve(root, "scripts", "test-anticodex-antigravity-cli-real-smoke.ps1"), "utf8");
  const gates = readFileSync(resolve(root, "scripts", "test-anticodex-release-gates.mjs"), "utf8");

  assert.match(smoke, /accountLaneRole\s*=\s*"anticodex-model-text"/);
  assert.match(smoke, /mcpAccountLaneManagedByAntiCodex\s*=\s*\$false/);
  assert.match(smoke, /mcpAccountLaneOwner\s*=\s*"external-antigravity-account-not-managed-here"/);
  assert.ok((smoke.match(/accountLaneRole\s*=\s*"anticodex-model-text"/g) || []).length >= 3);
  assert.ok((smoke.match(/mcpAccountLaneManagedByAntiCodex\s*=\s*\$false/g) || []).length >= 3);
  assert.ok((smoke.match(/mcpAccountLaneOwner\s*=\s*"external-antigravity-account-not-managed-here"/g) || []).length >= 3);

  assert.match(gates, /optional_antigravity_cli_real_smoke_account_lane_role/);
  assert.match(gates, /optional_antigravity_cli_real_smoke_mcp_lane_managed_by_anticodex/);
  assert.match(gates, /optional_antigravity_cli_real_smoke_mcp_lane_owner_mismatch/);
});

test("Anti-Codex ships a privacy-safe diagnostic bundle collector", () => {
  const collector = readFileSync(resolve(root, "scripts", "collect-anticodex-diagnostics.ps1"), "utf8");

  assert.match(collector, /diagnostic-bundles/);
  assert.match(collector, /\[int\]\$KeepBundles = 10/);
  assert.match(collector, /function Remove-OldDiagnosticBundles/);
  assert.match(collector, /retainedBundles/);
  assert.match(collector, /\/health/);
  assert.match(collector, /\/anticodex\/diagnostics/);
  assert.match(collector, /\/anticodex\/account/);
  assert.match(collector, /\/models/);
  assert.match(collector, /latest-installed-overall\.json/);
  assert.match(collector, /latest-installed-overall-fast\.json/);
  assert.match(collector, /latest-model-routing\.json/);
  assert.match(collector, /latest-model-thinking\.json/);
  assert.match(collector, /latest-codex-responses\.json/);
  assert.match(collector, /latest-real-work\.json/);
  assert.match(collector, /latest-real-mini-tool\.json/);
  assert.match(collector, /latest-real-small-project\.json/);
  assert.match(collector, /latest-native-tool-loop\.json/);
  assert.match(collector, /latest-tool-loop\.json/);
  assert.match(collector, /latest-native-multi-tool-loop\.json/);
  assert.match(collector, /latest-mcp-tool-loop\.json/);
  assert.match(collector, /latest-custom-tool-loop\.json/);
  assert.match(collector, /latest-compaction-resume\.json/);
  assert.match(collector, /latest-cancellation\.json/);
  assert.match(collector, /latest-web-tools\.json/);
  assert.match(collector, /latest-post-verification\.json/);
  assert.match(collector, /latest-source-preflight\.json/);
  assert.match(collector, /latest-shortcut-repair\.json/);
  assert.match(collector, /latest-manager-real-buttons\.json/);
  assert.match(collector, /latest-release-gates\.json/);
  assert.match(collector, /latest-log-db-guard\.json/);
  assert.match(collector, /latest-cold-relaunch\.json/);
  assert.match(collector, /latest-third-party-provider\.json/);
  assert.match(collector, /latest-real-third-party-provider\.json/);
  assert.match(collector, /latest-provider-antigravity-return\.json/);
  assert.match(collector, /translator-lifecycle\.json/);
  assert.match(collector, /translator-lifecycle\.jsonl/);
  assert.match(collector, /Remove-OldDiagnosticBundles -Root \$OutputRoot -Keep \$KeepBundles/);
  assert.match(collector, /\[switch\]\$NoPopup/);
  assert.match(collector, /usedRealTraffic/);
  assert.match(collector, /latestDiagnosis/);
  assert.match(collector, /latestDiagnosisDetail/);
  assert.match(collector, /accountProxyEvidence/);
  assert.match(collector, /repairedCount/);
  assert.match(collector, /repairedAt/);
  assert.match(collector, /failureCount/);
  assert.match(collector, /function Get-ReportIntegrity/);
  assert.match(collector, /\.sha256/);
  assert.match(collector, /Get-FileHash -LiteralPath \$Path -Algorithm SHA256/);
  assert.match(collector, /report hash validation failed/);
  assert.match(collector, /missingOptional/);
  assert.match(collector, /damagedReports/);
  assert.match(collector, /releaseGateGroups/);
  assert.match(collector, /releaseGateFailureReasons = @\(\$json\.releaseGateFailureReasons\)/);
  assert.match(collector, /nextActions = @\(\$json\.nextActions\)/);
  assert.match(collector, /nextActionsAvailableCount = \$json\.nextActionsAvailableCount/);
  assert.match(collector, /nextActionsHiddenCount = \$json\.nextActionsHiddenCount/);
  assert.match(collector, /nextActionsTruncated = \$json\.nextActionsTruncated/);
  assert.match(collector, /approvalPlan = \$json\.approvalPlan/);
  assert.match(collector, /releaseGateSelectedReports = @\(\$json\.releaseGateSelectedReports\)/);
  assert.match(collector, /installedRuntimeEvidence = \$json\.installedRuntimeEvidence/);
  assert.match(collector, /function Resolve-NodeForJsonSummary/);
  assert.match(collector, /function Invoke-NodeJsonSummary/);
  assert.match(collector, /node\.exe is required to summarize diagnostic reports/);
  assert.match(collector, /summarize-anticodex-report\.mjs/);
  assert.match(collector, /Invoke-NodeJsonSummary -Path \$Path/);
  assert.match(collector, /logDbGuardEvidence = \$json\.logDbGuardEvidence/);
  assert.match(collector, /AllowSafeSummaryFields/);
  assert.match(collector, /reports-summary\.json"\) @\(\$reportSummaries\) -AllowSafeSummaryFields/);
  assert.match(collector, /function Get-DiagnosticsSnapshotSummary/);
  assert.match(collector, /diagnostics-summary\.json/);
  assert.match(collector, /longTasks/);
  assert.match(collector, /otherRunningItems/);
  assert.match(collector, /manager_foreground/);
  assert.match(collector, /diagnosticsSummary = \$diagnosticsSummary/);
  assert.match(collector, /requestedRealTraffic/);
  assert.match(collector, /coverageKind/);
  assert.match(collector, /behaviorCovered/);
  assert.match(collector, /localConnectorVerifierOk = \$json\.localConnectorVerifierOk/);
  assert.match(collector, /coveredBy = \$json\.coveredBy/);
  assert.match(collector, /strictOptionalRealTraffic = \$json\.strictOptionalRealTraffic/);
  assert.match(collector, /optionalRealTrafficReady = \$json\.optionalRealTrafficReady/);
  assert.match(collector, /optionalRealTrafficFailures = @\(\$json\.optionalRealTrafficFailures/);
  assert.match(collector, /stabilitySoakEvidence = \$json\.stabilitySoakEvidence/);
  const reportSummarizer = readFileSync(resolve(root, "scripts", "summarize-anticodex-report.mjs"), "utf8");
  assert.match(reportSummarizer, /JSON\.parse\(readFileSync\(path, "utf8"\)\)/);
  assert.match(reportSummarizer, /managerButtonResults/);
  assert.match(reportSummarizer, /actionCenterHitsButton/);
  assert.match(reportSummarizer, /closeHitAreaOk/);
  assert.match(reportSummarizer, /managerOpenedNewPage/);
  assert.match(reportSummarizer, /pageTargetCountBeforeManagerOpen/);
  assert.match(reportSummarizer, /pageTargetCountAfterManagerOpen/);
  assert.match(reportSummarizer, /payload\.results/);
  assert.match(reportSummarizer, /providerContinuity/);
  assert.match(reportSummarizer, /releaseReady/);
  assert.match(reportSummarizer, /releaseBlockedOnlyByRequiredRealTraffic/);
  assert.match(reportSummarizer, /requiredRealTrafficBlockedGates/);
  assert.match(reportSummarizer, /effectiveOk/);
  assert.match(collector, /effectiveOk = \$json\.effectiveOk/);
  assert.match(reportSummarizer, /releaseGateEffectiveOk/);
  assert.match(reportSummarizer, /shortReady/);
  assert.match(reportSummarizer, /strictOptionalRealTraffic/);
  assert.match(reportSummarizer, /optionalRealTrafficReady/);
  assert.match(reportSummarizer, /optionalRealTrafficFailures/);
  assert.match(reportSummarizer, /sourceSnapshotEvidence/);
  assert.match(reportSummarizer, /cacheHitCount/);
  assert.match(reportSummarizer, /hashCacheHitCount/);
  assert.match(reportSummarizer, /logDbGuardEvidence/);
  assert.match(reportSummarizer, /missingRequired/);
  assert.match(reportSummarizer, /missingShort/);
  assert.match(reportSummarizer, /missingOptional/);
  assert.match(reportSummarizer, /releaseGateFailures/);
  assert.match(reportSummarizer, /releaseGateGroups/);
  assert.match(reportSummarizer, /releaseGateFailureReasons/);
  assert.match(reportSummarizer, /releaseGateFailureReasons[\s\S]*slice\(0, 64\)/);
  assert.match(reportSummarizer, /failureReasonsAvailableCount/);
  assert.match(reportSummarizer, /failureReasonsHiddenCount/);
  assert.match(reportSummarizer, /semanticFailuresAvailableCount/);
  assert.match(reportSummarizer, /semanticFailuresHiddenCount/);
  assert.match(reportSummarizer, /nextActionsAvailableCount/);
  assert.match(reportSummarizer, /nextActionsHiddenCount/);
  assert.match(reportSummarizer, /nextActionsTruncated/);
  assert.match(reportSummarizer, /reason: asString\(item\.reason\)/);
  assert.match(reportSummarizer, /guidance: asString\(item\.guidance\)/);
  assert.match(reportSummarizer, /approvalPlan/);
  assert.match(reportSummarizer, /asApprovalPlan/);
  assert.match(reportSummarizer, /reportOnly/);
  assert.match(reportSummarizer, /reportOnlyCount/);
  assert.match(reportSummarizer, /missingOptional/);
  assert.match(reportSummarizer, /reportFailureSampleCodes/);
  assert.match(reportSummarizer, /offlineSnapshotEvidence/);
  assert.match(reportSummarizer, /asOfflineSnapshotEvidence/);
  assert.match(reportSummarizer, /selectedKind/);
  assert.match(reportSummarizer, /selectedMtime/);
  assert.match(reportSummarizer, /historySourceMismatch/);
  assert.match(reportSummarizer, /reportFailureSamples/);
  assert.match(reportSummarizer, /guidance: asString\(gate\.guidance/);
  assert.match(reportSummarizer, /releaseGateSelectedReports/);
  assert.match(reportSummarizer, /installedRuntimeEvidence/);
  assert.match(reportSummarizer, /installedRuntimeFingerprint/);
  assert.match(reportSummarizer, /mismatchedRuntimeFiles/);
  assert.match(reportSummarizer, /requiredSatisfied/);
  assert.match(reportSummarizer, /optionalSatisfied/);
  assert.match(reportSummarizer, /semanticFailures/);
  assert.match(reportSummarizer, /requestedRealTraffic/);
  assert.match(reportSummarizer, /coverageKind/);
  assert.match(reportSummarizer, /behaviorCovered/);
  assert.match(reportSummarizer, /upstreamProfileStorageOk/);
  assert.match(reportSummarizer, /antigravityCliIsolationProfileOk/);
  assert.match(reportSummarizer, /antigravityCliIsolationProfileContract/);
  assert.match(reportSummarizer, /localConnectorVerifierOk/);
  assert.match(reportSummarizer, /modelRoutingEvidence/);
  assert.match(reportSummarizer, /modelThinkingEvidence/);
  assert.match(reportSummarizer, /supportsThinkingCount/);
  assert.match(reportSummarizer, /accountProxyEvidence/);
  assert.match(reportSummarizer, /localProxyBypassed/);
  assert.match(reportSummarizer, /antigravityLogSignals/);
  assert.match(reportSummarizer, /toolBridgeEvidence/);
  assert.match(reportSummarizer, /requestEnvelope/);
  assert.match(reportSummarizer, /externalToolDefinitionsField/);
  assert.match(reportSummarizer, /externalToolDefinitionsUsable/);
  assert.match(reportSummarizer, /schemaLikeRequestAcceptance/);
  assert.match(reportSummarizer, /nativeMcpToolCallStatus/);
  assert.match(reportSummarizer, /nativeMcpApprovalProtocolVerified/);
  assert.match(reportSummarizer, /uiIdleEvidence/);
  assert.match(reportSummarizer, /healthySampleCount/);
  assert.match(reportSummarizer, /syncReadinessEvidence/);
  assert.match(reportSummarizer, /clientSyncMode/);
  assert.match(reportSummarizer, /clientSyncMaintenancePath/);
  assert.match(reportSummarizer, /forbidsFeatureByFeatureReimplementation/);
  assert.match(reportSummarizer, /antiCodexPatchScope/);
  assert.match(reportSummarizer, /shortcutReadyCount/);
  assert.match(reportSummarizer, /codexVersion/);
  assert.match(reportSummarizer, /sourcePackageVersion/);
  assert.match(reportSummarizer, /sourcePackageVersion: report\.clientSyncContract/);
  assert.match(reportSummarizer, /activeSourcePackageVersion/);
  assert.match(reportSummarizer, /clientSyncVersionMatches/);
  assert.match(reportSummarizer, /updateStatusSource/);
  assert.match(reportSummarizer, /updateStatusReason/);
  assert.match(reportSummarizer, /sourceHostHash/);
  assert.match(reportSummarizer, /hostHashMatches/);
  assert.match(reportSummarizer, /updateDriftState/);
  assert.match(reportSummarizer, /managerBridgeProcessCount/);
  assert.match(reportSummarizer, /installedOverallEvidence/);
  assert.match(reportSummarizer, /realTrafficSkippedChecks/);
  assert.match(reportSummarizer, /managerVerifierBusyCheckCount/);
  assert.match(reportSummarizer, /manager-verifier-lock-busy/);
  assert.match(reportSummarizer, /crossProtocolWithoutHistoryLoss/);
  assert.match(reportSummarizer, /structuralEvidenceClean/);
  assert.match(reportSummarizer, /orderedHistoryClean/);
  assert.match(reportSummarizer, /previousResponseContinuity/);
  assert.match(reportSummarizer, /previousResponseIdChain/);
  assert.match(reportSummarizer, /saveMatched/);
  assert.match(reportSummarizer, /restartMatched/);
  assert.match(reportSummarizer, /providerSwitchMatchesNested/);
  assert.match(reportSummarizer, /sixthOrderedHistoryCount/);
  assert.match(reportSummarizer, /seventhOrderedHistoryCount/);
  assert.match(reportSummarizer, /eighthOrderedHistoryCount/);
  assert.match(reportSummarizer, /ninthOrderedHistoryCount/);
  assert.match(reportSummarizer, /reverseProtocolSwitchPreservesOpenAiToolPair/);
  assert.match(reportSummarizer, /sixthAfterRestartAllHistoryMarkerCount/);
  assert.match(reportSummarizer, /seventhAfterProviderSwitchAllHistoryMarkerCount/);
  assert.match(reportSummarizer, /eighthAfterProtocolSwitchAllHistoryMarkerCount/);
  assert.match(reportSummarizer, /ninthAfterReverseProtocolSwitchAllHistoryMarkerCount/);
  assert.match(reportSummarizer, /localConnectorEvidence/);
  assert.match(reportSummarizer, /chatgptInstallUrlsScrubbed/);
  assert.match(reportSummarizer, /upstreamRequestsDuringLocalEndpoints/);
  assert.match(reportSummarizer, /hiddenConnectorAccessible/);
  assert.match(reportSummarizer, /exposedToolNames/);
  assert.match(reportSummarizer, /behaviorCovered/);
  assert.match(reportSummarizer, /coverageKind/);
  assert.match(reportSummarizer, /pluginCapabilityEvidence/);
  assert.match(reportSummarizer, /connectorParityMissingShared/);
  assert.match(reportSummarizer, /appToolParityChangedShared/);
  assert.match(reportSummarizer, /appToolGetPostMissingFromGet/);
  assert.match(reportSummarizer, /mcpSkillEvidence/);
  assert.match(reportSummarizer, /mcpRealCallPassed/);
  assert.match(reportSummarizer, /mcpRealListCount/);
  assert.match(reportSummarizer, /mcpRealListPassed/);
  assert.match(reportSummarizer, /mcpRealListToolCount/);
  assert.match(reportSummarizer, /mcpRealListServers/);
  assert.match(reportSummarizer, /reusedFromPreviousReport/);
  assert.match(reportSummarizer, /skillFingerprintSkipped/);
  assert.match(reportSummarizer, /expectedSharedSkillCount/);
  assert.match(reportSummarizer, /appToolRegistryContentMatches/);
  assert.match(reportSummarizer, /appToolRegistryFingerprintMatches/);
  assert.match(reportSummarizer, /refreshFeatureEvidence/);
  assert.match(reportSummarizer, /connectorContentMatches/);
  assert.match(reportSummarizer, /appToolContentMatches/);
  assert.match(reportSummarizer, /changedExpectedSkills/);
  assert.match(reportSummarizer, /guidanceChanged/);
  assert.match(reportSummarizer, /recoveryActions/);
  assert.match(reportSummarizer, /recoveryActionIds/);
  assert.match(reportSummarizer, /optionalRealProviderEvidence/);
  assert.match(reportSummarizer, /realProviderToAntigravityReturnEvidence/);
  assert.match(reportSummarizer, /returnUpstream/);
  assert.match(reportSummarizer, /antigravityReturnEvidence/);
  assert.match(reportSummarizer, /historyContinuationObserved/);
  assert.match(reportSummarizer, /returnedToAntigravityWithHistory/);
  assert.match(reportSummarizer, /unauthorizedAppToolCount/);
  assert.match(reportSummarizer, /unattributedAppToolCount/);
  assert.match(reportSummarizer, /appToolGetCount/);
  assert.match(reportSummarizer, /appToolGetPostParityClean/);
  assert.match(reportSummarizer, /appToolGetPostParityContentMatches/);
  assert.match(reportSummarizer, /antigravityCliProfilePrepareEvidence/);
  assert.match(reportSummarizer, /antigravityCliWindowsUserLoginDryRunOk/);
  assert.match(reportSummarizer, /antigravityCliWindowsUserLoginDryRunContract/);
  assert.match(reportSummarizer, /readyForInteractiveLogin/);
  assert.match(reportSummarizer, /targetUserIsCurrentUser/);
  assert.match(reportSummarizer, /separateAccountVerified/);
  assert.match(reportSummarizer, /accountIsolationBoundary/);
  assert.match(reportSummarizer, /accountIsolationCaveat/);
  assert.match(reportSummarizer, /antigravityCliRealSmokeEvidence/);
  assert.match(reportSummarizer, /strictWindowsAppDataIsolation/);
  assert.match(reportSummarizer, /profileSource/);
  assert.match(reportSummarizer, /loginVerified/);
  assert.match(reportSummarizer, /loginVerifiedMethod/);
  assert.match(reportSummarizer, /separateAccountVerificationReason/);
  assert.match(reportSummarizer, /preparationReport/);
  assert.match(reportSummarizer, /profileMatched/);
  assert.doesNotMatch(collector, /failures = if \(\$json\.PSObject\.Properties\.Name -contains "failures"\)/);
  assert.doesNotMatch(collector, /failures = if \(\$result\.PSObject\.Properties\.Name -contains "failures"\)/);
  assert.match(collector, /\$resultFailures = if \(\$result\.PSObject\.Properties\.Name -contains "failures"\)/);
  assert.match(collector, /failures = @\(\$resultFailures\)/);
  assert.match(collector, /\$resultModels = if \(\$result\.PSObject\.Properties\.Name -contains "models"\)/);
  assert.match(collector, /models = @\(\$resultModels\)/);
  assert.match(collector, /function Update-NoTrafficModelRoutingReport/);
  assert.match(collector, /test-anticodex-model-routing\.ps1/);
  assert.match(collector, /-SkipRefresh -SkipRequests/);
  assert.match(collector, /model-routing-refresh\.json/);
  assert.match(collector, /modelCount/);
  assert.match(collector, /failures/);
  assert.match(collector, /skipRequests/);
  assert.match(collector, /adaptive-translator\.err\.log/);
  assert.match(collector, /Compress-Archive/);
  assert.match(collector, /logs_2\.sqlite/);
  assert.match(collector, /\(\?<!\[A-Za-z\]\)prompt\(\?!\[A-Za-z\]\)/);
  assert.match(collector, /\(\?<!\[A-Za-z\]\)messages\(\?!\[A-Za-z\]\)/);
  assert.match(collector, /input_items\|tool output\|Return exactly this/);
  assert.doesNotMatch(collector, /"prompt\|messages\|input_items\|tool output\|Return exactly this"/);
  assert.doesNotMatch(collector, /Get-ChildItem.+codex-home-deepseek-app/s);
  assert.doesNotMatch(collector, /\.env|OPENAI_API_KEY|ANTHROPIC_API_KEY|chatgpt\.com|auth\/login/);
});

test("report summarizer surfaces MCP and shared skill evidence values", () => {
  const tempRoot = mkdtempSync(resolve(os.tmpdir(), "anticodex-mcp-summarizer-"));
  const reportPath = resolve(tempRoot, "latest-mcp-skills.json");
  try {
    writeFileSync(reportPath, JSON.stringify({
      ok: true,
      reportName: "mcp-skills",
      shortBudgetMode: true,
      failures: [],
      baseUrl: "http://127.0.0.1:8484",
      hashCache: { hitCount: 12000, missCount: 42, entryCount: 12042 },
      sourceSnapshot: {
        fingerprint: "source-fp",
        sourceMtimeMax: "2026-06-24T00:00:00.000Z",
        fileCount: 15589,
        cacheHitCount: 12000,
        cacheMissCount: 42,
        reusedFromPreviousReport: true,
        refreshSkippedReason: "short_budget_reused_previous_snapshot",
      },
      mcp: {
        count: 8,
        sharedCount: 8,
        missingShared: ["missing-mcp"],
        extraLocal: ["extra-mcp"],
        changedShared: ["changed-mcp"],
        changedSharedDetails: [{ name: "changed-mcp", fields: ["args"] }],
        hasNodeRepl: true,
        smoke: {
          passed: true,
          realCall: { passed: true },
          realList: [
            { server: "antigravity-code-worker", passed: true, toolCount: 6 },
            { server: "deepseek-code-worker", passed: true, toolCount: 6 },
            { server: "deveco-code-worker", passed: true, toolCount: 6 },
            { server: "kilo-worker", passed: true, toolCount: 6 },
            { server: "mimo-claude-coworker", passed: true, toolCount: 6 },
            { server: "mimocode-worker", passed: true, toolCount: 6 },
            { server: "opencode-worker", passed: true, toolCount: 6 },
          ],
        },
      },
      skills: {
        count: 126,
        sharedCount: 100,
        agentsCount: 26,
        expectedSharedCount: 126,
        missingShared: ["missing-skill"],
        extraLocal: ["extra-skill"],
        changedShared: ["changed-skill"],
        changedSharedDetails: [{ name: "changed-skill", localFingerprint: "local", sharedFingerprint: "shared" }],
        duplicateNames: ["dupe-skill"],
        conflictingDuplicateNames: ["dupe-skill"],
        fingerprintSkipped: true,
        smoke: { readable: true },
      },
      appTools: {
        registry: {
          exists: true,
          contentMatches: true,
          sharedFileCount: 36,
          localFileCount: 36,
          sharedFingerprint: "shared-fp",
          localFingerprint: "shared-fp",
        },
      },
    }), "utf8");
    const result = spawnSync(process.execPath, [resolve(root, "scripts", "summarize-anticodex-report.mjs"), reportPath], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.mcpSkillEvidence.mcpCount, 8);
    assert.equal(summary.mcpSkillEvidence.hashCacheHitCount, 12000);
    assert.equal(summary.mcpSkillEvidence.hashCacheMissCount, 42);
    assert.equal(summary.mcpSkillEvidence.hashCacheEntryCount, 12042);
    assert.equal(summary.mcpSkillEvidence.mcpSharedCount, 8);
    assert.deepEqual(summary.mcpSkillEvidence.mcpMissingShared, ["missing-mcp"]);
    assert.deepEqual(summary.mcpSkillEvidence.mcpExtraLocal, ["extra-mcp"]);
    assert.deepEqual(summary.mcpSkillEvidence.mcpChangedShared, ["changed-mcp"]);
    assert.deepEqual(summary.mcpSkillEvidence.mcpChangedSharedDetails, [{ name: "changed-mcp", fields: ["args"] }]);
    assert.equal(summary.mcpSkillEvidence.hasNodeRepl, true);
    assert.equal(summary.mcpSkillEvidence.mcpSmokePassed, true);
    assert.equal(summary.mcpSkillEvidence.mcpRealCallPassed, true);
    assert.equal(summary.mcpSkillEvidence.mcpRealListCount, 7);
    assert.equal(summary.mcpSkillEvidence.mcpRealListPassed, 7);
    assert.equal(summary.mcpSkillEvidence.mcpRealListToolCount, 42);
    assert.deepEqual(summary.mcpSkillEvidence.mcpRealListServers, ["antigravity-code-worker", "deepseek-code-worker", "deveco-code-worker", "kilo-worker", "mimo-claude-coworker", "mimocode-worker", "opencode-worker"]);
    assert.deepEqual(summary.mcpSkillEvidence.mcpRealListPassedServers, ["antigravity-code-worker", "deepseek-code-worker", "deveco-code-worker", "kilo-worker", "mimo-claude-coworker", "mimocode-worker", "opencode-worker"]);
    assert.equal(summary.mcpSkillEvidence.skillCount, 126);
    assert.equal(summary.mcpSkillEvidence.skillSharedCount, 100);
    assert.equal(summary.mcpSkillEvidence.agentsSkillCount, 26);
    assert.equal(summary.mcpSkillEvidence.expectedSharedSkillCount, 126);
    assert.deepEqual(summary.mcpSkillEvidence.missingSharedSkills, ["missing-skill"]);
    assert.deepEqual(summary.mcpSkillEvidence.extraLocalSkills, ["extra-skill"]);
    assert.deepEqual(summary.mcpSkillEvidence.changedSharedSkills, ["changed-skill"]);
    assert.deepEqual(summary.mcpSkillEvidence.changedSharedSkillDetails, [{ name: "changed-skill", localFingerprint: "local", sharedFingerprint: "shared" }]);
    assert.deepEqual(summary.mcpSkillEvidence.duplicateSkillNames, ["dupe-skill"]);
    assert.deepEqual(summary.mcpSkillEvidence.conflictingDuplicateSkillNames, ["dupe-skill"]);
    assert.equal(summary.mcpSkillEvidence.skillFingerprintSkipped, true);
    assert.equal(summary.mcpSkillEvidence.skillSmokeReadable, true);
    assert.equal(summary.mcpSkillEvidence.appToolRegistryExists, true);
    assert.equal(summary.mcpSkillEvidence.appToolRegistryContentMatches, true);
    assert.equal(summary.mcpSkillEvidence.appToolRegistryFingerprintMatches, true);
    assert.equal(summary.mcpSkillEvidence.appToolRegistrySharedFileCount, 36);
    assert.equal(summary.mcpSkillEvidence.appToolRegistryLocalFileCount, 36);
    assert.equal(summary.shortBudgetMode, true);
    assert.equal(summary.sourceSnapshotEvidence.reusedFromPreviousReport, true);
    assert.equal(summary.sourceSnapshotEvidence.refreshSkippedReason, "short_budget_reused_previous_snapshot");
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("report summarizer surfaces refresh feature parity evidence", () => {
  const tempRoot = mkdtempSync(resolve(os.tmpdir(), "anticodex-refresh-summary-"));
  const reportPath = resolve(tempRoot, "latest-refresh-features.json");
  try {
    writeFileSync(reportPath, JSON.stringify({
      ok: false,
      reportName: "refresh-features",
      verifyOnly: true,
      elapsedMs: 73000,
      hashCache: { hitCount: 12000, missCount: 42, entryCount: 12042 },
      failures: ["connector drift"],
      connectorParity: {
        sharedExists: true,
        localExists: true,
        contentMatches: false,
        missingSharedCount: 1,
        missingSharedSample: ["missing-connector.json"],
        extraLocalCount: 2,
        extraLocalSample: ["extra-connector.json"],
        changedSharedCount: 3,
        changedSharedSample: ["changed-connector.json"],
      },
      appToolParity: {
        sharedExists: true,
        localExists: false,
        contentMatches: false,
        missingSharedCount: 4,
        missingSharedSample: ["missing-tool.json"],
        extraLocalCount: 5,
        extraLocalSample: ["extra-tool.json"],
        changedSharedCount: 6,
        changedSharedSample: ["changed-tool.json"],
      },
      skills: {
        changedExpected: ["changed-skill"],
        changedExpectedDetails: [{ name: "changed-skill", localFingerprint: "local", sharedFingerprint: "shared" }],
      },
      guidance: {
        "RTK.md": { sharedExists: true, localExists: true, contentMatches: false },
      },
    }), "utf8");
    const result = spawnSync(process.execPath, [resolve(root, "scripts", "summarize-anticodex-report.mjs"), reportPath], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.refreshFeatureEvidence.verifyOnly, true);
    assert.equal(summary.refreshFeatureEvidence.elapsedMs, 73000);
    assert.equal(summary.refreshFeatureEvidence.hashCacheHitCount, 12000);
    assert.equal(summary.refreshFeatureEvidence.hashCacheMissCount, 42);
    assert.equal(summary.refreshFeatureEvidence.hashCacheEntryCount, 12042);
    assert.equal(summary.refreshFeatureEvidence.connectorSharedExists, true);
    assert.equal(summary.refreshFeatureEvidence.connectorLocalExists, true);
    assert.equal(summary.refreshFeatureEvidence.connectorContentMatches, false);
    assert.equal(summary.refreshFeatureEvidence.connectorMissingSharedCount, 1);
    assert.deepEqual(summary.refreshFeatureEvidence.connectorMissingSharedSample, ["missing-connector.json"]);
    assert.equal(summary.refreshFeatureEvidence.connectorExtraLocalCount, 2);
    assert.deepEqual(summary.refreshFeatureEvidence.connectorExtraLocalSample, ["extra-connector.json"]);
    assert.equal(summary.refreshFeatureEvidence.connectorChangedSharedCount, 3);
    assert.deepEqual(summary.refreshFeatureEvidence.connectorChangedSharedSample, ["changed-connector.json"]);
    assert.equal(summary.refreshFeatureEvidence.appToolSharedExists, true);
    assert.equal(summary.refreshFeatureEvidence.appToolLocalExists, false);
    assert.equal(summary.refreshFeatureEvidence.appToolContentMatches, false);
    assert.equal(summary.refreshFeatureEvidence.appToolMissingSharedCount, 4);
    assert.deepEqual(summary.refreshFeatureEvidence.appToolMissingSharedSample, ["missing-tool.json"]);
    assert.equal(summary.refreshFeatureEvidence.appToolExtraLocalCount, 5);
    assert.deepEqual(summary.refreshFeatureEvidence.appToolExtraLocalSample, ["extra-tool.json"]);
    assert.equal(summary.refreshFeatureEvidence.appToolChangedSharedCount, 6);
    assert.deepEqual(summary.refreshFeatureEvidence.appToolChangedSharedSample, ["changed-tool.json"]);
    assert.deepEqual(summary.refreshFeatureEvidence.changedExpectedSkills, ["changed-skill"]);
    assert.deepEqual(summary.refreshFeatureEvidence.changedExpectedSkillDetails, [{ name: "changed-skill", localFingerprint: "local", sharedFingerprint: "shared" }]);
    assert.deepEqual(summary.refreshFeatureEvidence.guidanceChanged, ["RTK.md"]);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("refresh feature verifier reuses unchanged file hash cache", () => {
  const tempRoot = mkdtempSync(join(os.tmpdir(), "anticodex-refresh-cache-"));
  const stateRoot = join(tempRoot, "state");
  const codexHome = join(tempRoot, "local");
  const sharedHome = join(tempRoot, "shared");
  const agentsSkills = join(tempRoot, "agents-skills");
  const reportRoot = join(tempRoot, "reports");
  try {
    mkdirSync(join(sharedHome, "skills", "alpha"), { recursive: true });
    mkdirSync(join(agentsSkills, "beta"), { recursive: true });
    mkdirSync(join(codexHome, "skills", "alpha"), { recursive: true });
    mkdirSync(join(codexHome, "skills", "beta"), { recursive: true });
    mkdirSync(join(sharedHome, "cache", "codex_app_directory"), { recursive: true });
    mkdirSync(join(sharedHome, "cache", "codex_apps_tools"), { recursive: true });
    mkdirSync(join(codexHome, "cache", "codex_app_directory"), { recursive: true });
    mkdirSync(join(codexHome, "cache", "codex_apps_tools"), { recursive: true });
    writeFileSync(join(codexHome, "config.toml"), "[mcp_servers.node_repl]\ncommand='node'\n", "utf8");
    writeFileSync(join(sharedHome, "config.toml"), "[mcp_servers.node_repl]\ncommand='node'\n", "utf8");
    writeFileSync(join(sharedHome, "skills", "alpha", "SKILL.md"), "alpha skill\n", "utf8");
    writeFileSync(join(codexHome, "skills", "alpha", "SKILL.md"), "alpha skill\n", "utf8");
    writeFileSync(join(agentsSkills, "beta", "SKILL.md"), "beta skill\n", "utf8");
    writeFileSync(join(codexHome, "skills", "beta", "SKILL.md"), "beta skill\n", "utf8");
    writeFileSync(join(sharedHome, "cache", "codex_app_directory", "one.json"), "{\"id\":\"one\"}\n", "utf8");
    writeFileSync(join(codexHome, "cache", "codex_app_directory", "one.json"), "{\"id\":\"one\"}\n", "utf8");
    writeFileSync(join(sharedHome, "cache", "codex_apps_tools", "one.json"), "{\"tool\":\"one\"}\n", "utf8");
    writeFileSync(join(codexHome, "cache", "codex_apps_tools", "one.json"), "{\"tool\":\"one\"}\n", "utf8");
    for (const name of ["AGENTS.md", "DEFAULT_SKILL_ALLOWLIST.md", "RTK.md", "MCP_WORKER_USAGE_GUIDE.md"]) {
      writeFileSync(join(sharedHome, name), `${name}\n`, "utf8");
      writeFileSync(join(codexHome, name), `${name}\n`, "utf8");
    }
    const args = [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      resolve(root, "scripts", "refresh-anticodex-local-features.ps1"),
      "-StateRoot",
      stateRoot,
      "-CodexHome",
      codexHome,
      "-SharedCodexHome",
      sharedHome,
      "-AgentsSkillsPath",
      agentsSkills,
      "-ReportRoot",
      reportRoot,
      "-VerifyOnly",
    ];
    const first = spawnSync("powershell.exe", args, { encoding: "utf8" });
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const firstReport = JSON.parse(first.stdout.trim());
    const second = spawnSync("powershell.exe", args, { encoding: "utf8" });
    assert.equal(second.status, 0, second.stderr || second.stdout);
    const secondReport = JSON.parse(second.stdout.trim());
    assert.ok(firstReport.hashCache.missCount > 0);
    assert.equal(firstReport.hashCache.hitCount, 0);
    assert.ok(secondReport.hashCache.hitCount >= firstReport.hashCache.missCount);
    assert.equal(secondReport.hashCache.missCount, 0);
    assert.equal(secondReport.ok, true);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("report summarizer surfaces source preflight profile storage evidence", () => {
  const tempRoot = mkdtempSync(resolve(os.tmpdir(), "anticodex-source-preflight-summarizer-"));
  const reportPath = resolve(tempRoot, "latest-source-preflight.json");
  try {
    writeFileSync(reportPath, JSON.stringify({
      ok: true,
      reportName: "source-preflight",
      noTraffic: true,
      usedRealTraffic: false,
      behaviorCovered: true,
      coverageKind: "source-no-traffic",
      skipFullRegression: true,
      failures: [],
      checks: {
        javascriptSyntax: { ok: true },
        powershellSyntax: { ok: true },
        uiStateSelfTest: { ok: true },
        upstreamProfileStorage: { ok: true },
        antigravityCliIsolationProfile: { ok: true },
        antigravityCliProfilePrepare: { ok: true, contract: {
          usedRealTraffic: false,
          loginVerified: false,
          separateAccountVerified: false,
          accountLaneRole: "anticodex-model-text",
          mcpAccountLaneManagedByAntiCodex: false,
          mcpAccountLaneOwner: "external-antigravity-account-not-managed-here",
          coverageKind: "profile-prepared-no-traffic",
          accountIsolationBoundary: "appdata-isolation",
          accountIsolationCaveat: "no real dual-account proof; only AppData isolation verified",
        } },
        localConnectorVerifier: { ok: true },
        publicDocumentation: {
          ok: true,
          assertions: [
            { file: "README.md", name: "client-copy-sync-contract", ok: true },
            { file: "README_EN.md", name: "client-copy-sync-contract", ok: true },
          ],
        },
        translatorRegression: { ok: true },
        diffWhitespace: { ok: true },
      },
      sourceSnapshot: {
        fingerprint: "source-fingerprint",
        sourceMtimeMax: "2026-06-23T00:00:00.000Z",
        fileCount: 15589,
        cacheHitCount: 12000,
        cacheMissCount: 42,
      },
    }), "utf8");
    const result = spawnSync(process.execPath, [resolve(root, "scripts", "summarize-anticodex-report.mjs"), reportPath], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.noTraffic, true);
    assert.equal(summary.usedRealTraffic, false);
    assert.equal(summary.behaviorCovered, true);
    assert.equal(summary.coverageKind, "source-no-traffic");
    assert.equal(summary.javascriptSyntaxOk, true);
    assert.equal(summary.powershellSyntaxOk, true);
    assert.equal(summary.uiStateSelfTestOk, true);
    assert.equal(summary.upstreamProfileStorageOk, true);
    assert.equal(summary.antigravityCliIsolationProfileOk, true);
    assert.equal(summary.antigravityCliProfilePrepareOk, true);
    assert.deepEqual(summary.antigravityCliProfilePrepareContract, {
      usedRealTraffic: false,
      loginVerified: false,
      separateAccountVerified: false,
      accountLaneRole: "anticodex-model-text",
      mcpAccountLaneManagedByAntiCodex: false,
      mcpAccountLaneOwner: "external-antigravity-account-not-managed-here",
      coverageKind: "profile-prepared-no-traffic",
      accountIsolationBoundary: "appdata-isolation",
      accountIsolationCaveat: "no real dual-account proof; only AppData isolation verified",
    });
    assert.equal(summary.localConnectorVerifierOk, true);
    assert.equal(summary.publicDocumentationOk, true);
    assert.equal(summary.publicDocumentationClientCopySyncContractOk, true);
    assert.equal(summary.translatorRegressionOk, true);
    assert.equal(summary.diffWhitespaceOk, true);
    assert.equal(summary.sourceSnapshotEvidence.cacheHitCount, 12000);
    assert.equal(summary.sourceSnapshotEvidence.cacheMissCount, 42);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("report summarizer surfaces model routing no-traffic evidence", () => {
  const tempRoot = mkdtempSync(resolve(os.tmpdir(), "anticodex-model-routing-summarizer-"));
  const reportPath = resolve(tempRoot, "latest-model-routing.json");
  try {
    writeFileSync(reportPath, JSON.stringify({
      ok: true,
      reportName: "model-routing",
      mode: "antigravity",
      providerProtocol: "",
      providerModel: "",
      toolBridge: { mode: "native-mcp-same-cascade" },
      modelCount: 2,
      models: ["a", "b"],
      skipRequests: true,
      results: [
        { model: "a", ok: true, skippedRequest: true, error: null },
        { model: "b", ok: false, skippedRequest: false, error: "bad" },
      ],
    }), "utf8");
    const result = spawnSync(process.execPath, [resolve(root, "scripts", "summarize-anticodex-report.mjs"), reportPath], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.modelRoutingEvidence.mode, "antigravity");
    assert.equal(summary.modelRoutingEvidence.toolBridgeMode, "native-mcp-same-cascade");
    assert.equal(summary.modelRoutingEvidence.resultCount, 2);
    assert.equal(summary.modelRoutingEvidence.skippedRequestCount, 1);
    assert.equal(summary.modelRoutingEvidence.failedResultCount, 1);
    assert.equal(summary.modelRoutingEvidence.resultErrorCount, 1);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("report summarizer surfaces model thinking no-traffic evidence", () => {
  const tempRoot = mkdtempSync(resolve(os.tmpdir(), "anticodex-model-thinking-summarizer-"));
  const reportPath = resolve(tempRoot, "latest-model-thinking.json");
  try {
    writeFileSync(reportPath, JSON.stringify({
      ok: true,
      expectedModelCount: 2,
      actualModelCount: 2,
      models: [
        { id: "a", display_name: "A", reasoning_level: "low", supports_thinking: true, thinking_budget: 4000, min_thinking_budget: 32 },
        { id: "b", display_name: "B", reasoning_level: "high", supports_thinking: true, thinking_budget: 10000, min_thinking_budget: 128 },
      ],
    }), "utf8");
    const result = spawnSync(process.execPath, [resolve(root, "scripts", "summarize-anticodex-report.mjs"), reportPath], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.modelThinkingEvidence.expectedModelCount, 2);
    assert.equal(summary.modelThinkingEvidence.actualModelCount, 2);
    assert.equal(summary.modelThinkingEvidence.modelCount, 2);
    assert.equal(summary.modelThinkingEvidence.supportsThinkingCount, 2);
    assert.equal(summary.modelThinkingEvidence.missingBudgetCount, 0);
    assert.deepEqual(summary.modelThinkingEvidence.reasoningLevels, ["high", "low"]);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("report summarizer surfaces tool bridge no-traffic evidence", () => {
  const tempRoot = mkdtempSync(resolve(os.tmpdir(), "anticodex-tool-bridge-summarizer-"));
  const reportPath = resolve(tempRoot, "latest-tool-bridge-mode.json");
  try {
    writeFileSync(reportPath, JSON.stringify({
      ok: true,
      reportName: "tool-bridge-mode",
      toolBridge: {
        mode: "native-mcp-same-cascade",
        transport: "desktop-cascade",
        localAdapter: "native-mcp-same-cascade-with-prompt-fallback",
        nativeAntigravityToolEvents: true,
        nativeMcpDiscoveryVerified: true,
        nativeBridgeDefaultEnabled: true,
        acceptsExternalToolDefinitions: true,
      },
      compatibilityTools: { bridge: "native_mcp_same_cascade" },
      nativeToolCapability: {
        requestEnvelope: "StartCascade.customAgentSpec + SendUserCascadeMessage.cascadeConfig.plannerConfig",
        externalToolDefinitionsField: "StartCascade.customAgentSpec.customizationConfig.customizationServerUrl",
        externalToolDefinitionsUsable: true,
        schemaLikeRequestAcceptance: "verified-native-mcp-initialize-and-tools-list",
        nativeMcpToolCallStatus: "verified-tools-call-after-automatic-permission",
        nativeMcpApprovalProtocolVerified: true,
        nativeMcpPermissionMode: "automatic-before-codex-execution",
        sameCascadeResumeProbeVerified: true,
        antigravityOwnedToolsDisabled: true,
        permissionPromptsDisabled: true,
        disabledToolCount: 23,
        codexToolBridge: "native-mcp-same-cascade-with-prompt-fallback",
      },
    }), "utf8");
    const result = spawnSync(process.execPath, [resolve(root, "scripts", "summarize-anticodex-report.mjs"), reportPath], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.toolBridgeEvidence.mode, "native-mcp-same-cascade");
    assert.equal(summary.toolBridgeEvidence.transport, "desktop-cascade");
    assert.equal(summary.toolBridgeEvidence.localAdapter, "native-mcp-same-cascade-with-prompt-fallback");
    assert.equal(summary.toolBridgeEvidence.compatibilityBridge, "native_mcp_same_cascade");
    assert.equal(summary.toolBridgeEvidence.requestEnvelope, "StartCascade.customAgentSpec + SendUserCascadeMessage.cascadeConfig.plannerConfig");
    assert.equal(summary.toolBridgeEvidence.externalToolDefinitionsField, "StartCascade.customAgentSpec.customizationConfig.customizationServerUrl");
    assert.equal(summary.toolBridgeEvidence.externalToolDefinitionsUsable, true);
    assert.equal(summary.toolBridgeEvidence.schemaLikeRequestAcceptance, "verified-native-mcp-initialize-and-tools-list");
    assert.equal(summary.toolBridgeEvidence.nativeMcpToolCallStatus, "verified-tools-call-after-automatic-permission");
    assert.equal(summary.toolBridgeEvidence.nativeMcpApprovalProtocolVerified, true);
    assert.equal(summary.toolBridgeEvidence.nativeMcpPermissionMode, "automatic-before-codex-execution");
    assert.equal(summary.toolBridgeEvidence.sameCascadeResumeProbeVerified, true);
    assert.equal(summary.toolBridgeEvidence.disabledToolCount, 23);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("report summarizer surfaces UI idle no-traffic evidence", () => {
  const tempRoot = mkdtempSync(resolve(os.tmpdir(), "anticodex-ui-idle-summarizer-"));
  const reportPath = resolve(tempRoot, "latest-ui-idle-stability.json");
  try {
    writeFileSync(reportPath, JSON.stringify({
      ok: true,
      durationSec: 10,
      intervalSec: 5,
      sampleCount: 2,
      samples: [
        { healthOk: true, accountReady: true, modelCount: 8, uiOk: true, hasReconnectText: false, hasLoginText: false, matchedModelText: "Gemini" },
        { healthOk: true, accountReady: true, modelCount: 8, uiOk: true, hasReconnectText: false, hasLoginText: false, matchedModelText: "Claude" },
      ],
    }), "utf8");
    const result = spawnSync(process.execPath, [resolve(root, "scripts", "summarize-anticodex-report.mjs"), reportPath], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.uiIdleEvidence.durationSec, 10);
    assert.equal(summary.uiIdleEvidence.sampleCount, 2);
    assert.equal(summary.uiIdleEvidence.sampleEntryCount, 2);
    assert.equal(summary.uiIdleEvidence.healthySampleCount, 2);
    assert.equal(summary.uiIdleEvidence.reconnectTextCount, 0);
    assert.equal(summary.uiIdleEvidence.loginTextCount, 0);
    assert.equal(summary.uiIdleEvidence.missingModelTextCount, 0);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("report summarizer surfaces sync readiness no-traffic evidence", () => {
  const tempRoot = mkdtempSync(resolve(os.tmpdir(), "anticodex-sync-readiness-summarizer-"));
  const reportPath = resolve(tempRoot, "latest-sync-readiness.json");
  try {
    writeFileSync(reportPath, JSON.stringify({
      ok: true,
      reportName: "sync-readiness",
      fast: false,
      noTraffic: true,
      usedRealTraffic: false,
      behaviorCovered: true,
      coverageKind: "installed-no-traffic",
      skipIconPaletteProbe: false,
      clientSyncContract: {
        mode: "codex-client-copy-plus-anticodex-patches",
        maintenancePath: "guarded-host-sync-then-reapply-anticodex-patches",
        nativeClientBehaviorCarriedByHostSync: true,
        forbidsFeatureByFeatureReimplementation: true,
        sourcePackageName: "OpenAI.Codex",
        sourcePackageVersion: "4.5.6",
        activeSourcePackageName: "OpenAI.Codex",
        activeSourcePackageVersion: "4.5.6",
        sourceHostHashMatches: true,
        sourceCliHashMatches: true,
        antiCodexPatchScope: ["branding", "icons", "shortcuts", "isolation", "launcher", "model-adapter"],
      },
      activeHost: {
        exists: true,
        markerExists: true,
        manifestValid: true,
        exeExists: true,
        productName: "Anti-Codex",
        fileDescription: "Anti-Codex",
        originalFilename: "Anti-Codex.exe",
        codexVersion: "1.2.3",
        sourcePackageVersion: "4.5.5-active-host",
        hostIconExists: true,
        trayIconExists: true,
        appRootIconExists: true,
        hostIconPalette: { ok: true },
        trayIconPalette: { ok: true },
        appRootIconPalette: { ok: true },
      },
      sync: {
        scriptExists: true,
        launcherExists: true,
        rollbackScriptExists: true,
        rollbackLauncherExists: true,
        updateCheckExists: true,
        validatorExists: true,
        failureSafetyVerifierExists: true,
        installerExists: true,
        startScriptExists: true,
        updateStatusSource: "installed-runtime",
        desktopShortcutIconPalette: { ok: true },
        updateStatus: {
          ok: true,
          updateNeeded: false,
          reason: "already_synced",
          source: { packageVersion: "4.5.6", hostHash: "SOURCEHOST123456", cliHash: "SOURCECLI123456" },
          active: { packageVersion: "4.5.6", hostHash: "SOURCEHOST123456", cliHash: "SOURCECLI123456" },
          drift: { state: "synced", hostChanged: false, cliChanged: false, activePackageVersion: "4.5.6" },
          guardrails: { brandPreserved: true, iconPreserved: true, activeHostValid: true, failures: [] },
        },
        shortcutVerification: [
          { ok: true, exists: true, displayNameMatches: true, targetMatches: true, launcherTargetMatches: true, scriptMatches: true, iconMatches: true, forbiddenCodexBranding: false },
          { ok: false, exists: true, displayNameMatches: true, targetMatches: true, launcherTargetMatches: true, scriptMatches: true, iconMatches: true, forbiddenCodexBranding: false },
        ],
        desktopAntiCodexShortcuts: ["Anti-Codex.lnk"],
        forbiddenDesktopHelperShortcuts: [],
        managerBridge: { processCount: 1, staleProcessCount: 0, processes: [{ hasExpectedBaseUrl: true }] },
        hostSyncMarkerExists: false,
        staleCandidateExists: false,
        rollbackHostExists: true,
        rollbackMarkerExists: true,
      },
    }), "utf8");
    const result = spawnSync(process.execPath, [resolve(root, "scripts", "summarize-anticodex-report.mjs"), reportPath], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.syncReadinessEvidence.noTrafficReady, true);
    assert.equal(summary.syncReadinessEvidence.fullMode, true);
    assert.equal(summary.syncReadinessEvidence.clientSyncMode, "codex-client-copy-plus-anticodex-patches");
    assert.equal(summary.syncReadinessEvidence.clientSyncMaintenancePath, "guarded-host-sync-then-reapply-anticodex-patches");
    assert.equal(summary.syncReadinessEvidence.nativeClientBehaviorCarriedByHostSync, true);
    assert.equal(summary.syncReadinessEvidence.forbidsFeatureByFeatureReimplementation, true);
    assert.equal(summary.syncReadinessEvidence.sourcePackageName, "OpenAI.Codex");
    assert.equal(summary.syncReadinessEvidence.activeSourcePackageName, "OpenAI.Codex");
    assert.equal(summary.syncReadinessEvidence.clientSyncHostHashMatches, true);
    assert.equal(summary.syncReadinessEvidence.clientSyncCliHashMatches, true);
    assert.deepEqual(summary.syncReadinessEvidence.antiCodexPatchScope, ["branding", "icons", "shortcuts", "isolation", "launcher", "model-adapter"]);
    assert.equal(summary.syncReadinessEvidence.activeHostReady, true);
    assert.equal(summary.syncReadinessEvidence.brandReady, true);
    assert.equal(summary.syncReadinessEvidence.iconReady, true);
    assert.equal(summary.syncReadinessEvidence.syncScriptsReady, true);
    assert.equal(summary.syncReadinessEvidence.codexVersion, "1.2.3");
    assert.equal(summary.syncReadinessEvidence.sourcePackageVersion, "4.5.6");
    assert.equal(summary.syncReadinessEvidence.updateStatusSource, "installed-runtime");
    assert.equal(summary.syncReadinessEvidence.updateStatusReason, "already_synced");
    assert.equal(summary.syncReadinessEvidence.updateDriftState, "synced");
    assert.equal(summary.syncReadinessEvidence.updateDriftHostChanged, false);
    assert.equal(summary.syncReadinessEvidence.updateDriftCliChanged, false);
    assert.equal(summary.syncReadinessEvidence.activePackageVersion, "4.5.6");
    assert.equal(summary.syncReadinessEvidence.activeSourcePackageVersion, "4.5.6");
    assert.equal(summary.syncReadinessEvidence.clientSyncVersionMatches, true);
    assert.equal(summary.syncReadinessEvidence.sourceHostHash, "SOURCEHOST123456");
    assert.equal(summary.syncReadinessEvidence.activeHostHash, "SOURCEHOST123456");
    assert.equal(summary.syncReadinessEvidence.sourceCliHash, "SOURCECLI123456");
    assert.equal(summary.syncReadinessEvidence.activeCliHash, "SOURCECLI123456");
    assert.equal(summary.syncReadinessEvidence.hostHashMatches, true);
    assert.equal(summary.syncReadinessEvidence.cliHashMatches, true);
    assert.equal(summary.syncReadinessEvidence.updateReady, true);
    assert.equal(summary.syncReadinessEvidence.guardrailsReady, true);
    assert.equal(summary.syncReadinessEvidence.shortcutCount, 2);
    assert.equal(summary.syncReadinessEvidence.shortcutReadyCount, 1);
    assert.equal(summary.syncReadinessEvidence.managerBridgeProcessCount, 1);
    assert.equal(summary.syncReadinessEvidence.managerBridgeStaleProcessCount, 0);
    assert.equal(summary.syncReadinessEvidence.managerBridgeReady, true);
    assert.equal(summary.syncReadinessEvidence.cleanSyncState, true);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("report summarizer surfaces account proxy readiness evidence without identity fingerprints", () => {
  const tempRoot = mkdtempSync(resolve(os.tmpdir(), "anticodex-account-proxy-summarizer-"));
  const reportPath = resolve(tempRoot, "latest-account-proxy-readiness.json");
  try {
    writeFileSync(reportPath, JSON.stringify({
      ok: true,
      reportName: "account-proxy-readiness",
      diagnosisDetail: "ready",
      suggestedAction: "No action needed.",
      localProxyBypassed: true,
      phaseSummary: {
        accountOk: true,
        refreshOk: true,
        modelCount: 8,
        realRequestAttempted: true,
        realRequestOk: true,
        accountError: "",
        refreshError: "",
        realRequestError: "",
      },
      antigravityLogSignals: {
        sourcePresent: true,
        sourceFresh: true,
        tailLinesScanned: 340,
        verificationRequiredCount: 0,
        tokenRefreshMissingCount: 0,
        oauthNetworkFailureCount: 0,
        generalNetworkFailureCount: 2,
      },
      account: {
        ok: true,
        fingerprint: "sha256:should-not-leak",
        planName: "Pro",
      },
    }), "utf8");
    const result = spawnSync(process.execPath, [resolve(root, "scripts", "summarize-anticodex-report.mjs"), reportPath], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.accountProxyEvidence.diagnosisDetail, "ready");
    assert.equal(summary.accountProxyEvidence.suggestedAction, "No action needed.");
    assert.equal(summary.accountProxyEvidence.localProxyBypassed, true);
    assert.equal(summary.accountProxyEvidence.phaseSummary.modelCount, 8);
    assert.equal(summary.accountProxyEvidence.phaseSummary.realRequestOk, true);
    assert.equal(summary.accountProxyEvidence.antigravityLogSignals.tailLinesScanned, 340);
    assert.equal(summary.accountProxyEvidence.antigravityLogSignals.generalNetworkFailureCount, 2);
    assert.doesNotMatch(JSON.stringify(summary), /should-not-leak|fingerprint/);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("report summarizer surfaces real Manager button evidence", () => {
  const tempRoot = mkdtempSync(resolve(os.tmpdir(), "anticodex-manager-buttons-summarizer-"));
  const reportPath = resolve(tempRoot, "latest-manager-real-buttons.json");
  const actionPayload = (action) => ({
    ok: true,
    payload: {
      result: {
        bridgeReady: true,
        overlayPresent: true,
        lastUiOnly: false,
        initial: {
          bridgeReady: true,
          actionCenterHitsButton: true,
          closeHitAreaOk: true,
          closeHitResults: [
            { name: "center", hit: true, target: "BUTTON" },
            { name: "top-left", hit: true, target: "BUTTON" },
          ],
        },
        managerOpenedNewPage: false,
        pageTargetCountBeforeManagerOpen: 1,
        pageTargetCountAfterManagerOpen: 1,
        action,
      },
    },
  });
  try {
    writeFileSync(reportPath, JSON.stringify({
      ok: true,
      reportName: "manager-real-buttons",
      managerButton: {
        ok: true,
        results: {
          mcpSkills: actionPayload("mcpSkills"),
          pluginCapabilities: actionPayload("pluginCapabilities"),
        },
      },
    }), "utf8");
    const result = spawnSync(process.execPath, [resolve(root, "scripts", "summarize-anticodex-report.mjs"), reportPath], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.managerButtonOk, true);
    assert.equal(summary.managerButtonResults.length, 2);
    for (const item of summary.managerButtonResults) {
      assert.equal(item.ok, true);
      assert.equal(item.lastUiOnly, false);
      assert.equal(item.bridgeReady, true);
      assert.equal(item.overlayPresent, true);
      assert.equal(item.actionCenterHitsButton, true);
      assert.equal(item.closeHitAreaOk, true);
      assert.equal(item.managerOpenedNewPage, false);
      assert.equal(item.pageTargetCountBeforeManagerOpen, 1);
      assert.equal(item.pageTargetCountAfterManagerOpen, 1);
      assert.equal(item.closeHitResults.length, 2);
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("report summarizer surfaces installed overall no-traffic evidence", () => {
  const tempRoot = mkdtempSync(resolve(os.tmpdir(), "anticodex-installed-overall-summarizer-"));
  const reportPath = resolve(tempRoot, "latest-installed-overall.json");
  try {
    writeFileSync(reportPath, JSON.stringify({
      ok: true,
      reportName: "installed-overall",
      fast: false,
      noTraffic: true,
      usedRealTraffic: false,
      behaviorCovered: true,
      coverageKind: "installed-no-traffic",
      elapsedMs: 1234,
      health: {
        modelTextTransport: "cli",
        modelDiscoverySource: "antigravity-desktop-catalog",
        antigravityCoworkerDefault: false,
      },
      checks: {
        branding: { ok: true },
        managerAction: { ok: true, skipped: true, reason: "covered elsewhere", coveredBy: "manager" },
        realMiniTool: { ok: true, skipped: true, reason: "requires -AllowRealTraffic", coveredBy: "test-anticodex-real-mini-tool.ps1" },
        realWork: { ok: true, skipped: true, reason: "requires -AllowRealTraffic", coveredBy: "test-anticodex-real-work.ps1" },
      },
    }), "utf8");
    const result = spawnSync(process.execPath, [resolve(root, "scripts", "summarize-anticodex-report.mjs"), reportPath], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.installedOverallEvidence.reportName, "installed-overall");
    assert.equal(summary.installedOverallEvidence.noTraffic, true);
    assert.equal(summary.installedOverallEvidence.usedRealTraffic, false);
    assert.equal(summary.installedOverallEvidence.behaviorCovered, true);
    assert.equal(summary.installedOverallEvidence.coverageKind, "installed-no-traffic");
    assert.equal(summary.installedOverallEvidence.checkCount, 4);
    assert.equal(summary.installedOverallEvidence.failedCheckCount, 0);
    assert.equal(summary.installedOverallEvidence.skippedCheckCount, 3);
    assert.equal(summary.installedOverallEvidence.missingSkipMetadataCount, 0);
    assert.equal(summary.installedOverallEvidence.managerVerifierBusyCheckCount, 0);
    assert.deepEqual(summary.installedOverallEvidence.managerVerifierBusyChecks, []);
    assert.deepEqual(summary.installedOverallEvidence.realTrafficSkippedChecks, ["realMiniTool", "realWork"]);
    assert.equal(summary.installedOverallEvidence.modelTextTransport, "cli");
    assert.equal(summary.installedOverallEvidence.modelDiscoverySource, "antigravity-desktop-catalog");
    assert.equal(summary.installedOverallEvidence.antigravityCoworkerDefault, false);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("report summarizer surfaces Manager verifier busy lock evidence", () => {
  const tempRoot = mkdtempSync(resolve(os.tmpdir(), "anticodex-installed-overall-busy-summarizer-"));
  const reportPath = resolve(tempRoot, "latest-installed-overall.json");
  try {
    writeFileSync(reportPath, JSON.stringify({
      ok: true,
      reportName: "installed-overall",
      fast: false,
      noTraffic: true,
      usedRealTraffic: false,
      behaviorCovered: true,
      coverageKind: "installed-no-traffic",
      health: {
        modelTextTransport: "cli",
        modelDiscoverySource: "antigravity-desktop-catalog",
        antigravityCoworkerDefault: false,
      },
      checks: {
        branding: { ok: true },
        managerVerifierBusy: {
          ok: true,
          skipped: true,
          reason: "Manager/UI verifier lock is already held; rerun installed overall serially",
          coveredBy: "serial rerun",
          coverageKind: "manager-verifier-lock-busy",
        },
        realMiniTool: { ok: true, skipped: true, reason: "requires -AllowRealTraffic", coveredBy: "test-anticodex-real-mini-tool.ps1" },
        realWork: { ok: true, skipped: true, reason: "requires -AllowRealTraffic", coveredBy: "test-anticodex-real-work.ps1" },
      },
    }), "utf8");
    const result = spawnSync(process.execPath, [resolve(root, "scripts", "summarize-anticodex-report.mjs"), reportPath], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.installedOverallEvidence.managerVerifierBusyCheckCount, 1);
    assert.deepEqual(summary.installedOverallEvidence.managerVerifierBusyChecks, ["managerVerifierBusy"]);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("report summarizer surfaces cold relaunch evidence", () => {
  const tempRoot = mkdtempSync(resolve(os.tmpdir(), "anticodex-cold-relaunch-summarizer-"));
  const reportPath = resolve(tempRoot, "latest-cold-relaunch.json");
  try {
    writeFileSync(reportPath, JSON.stringify({
      ok: true,
      reportName: "cold-relaunch",
      failures: [],
      health: {
        ok: true,
        providerReady: true,
        mode: "antigravity",
        upstream: "antigravity-desktop",
        modelCount: 8,
      },
      processes: {
        mainCount: 1,
        translatorCount: 1,
        launcherCount: 1,
      },
      launcher: {
        started: true,
        hasExited: true,
        exitCode: 0,
        stdoutTail: "Anti-Codex launched successfully",
        stderrTail: "",
      },
      originalCodex: {
        unchanged: true,
        beforePids: [11],
        afterPids: [11],
      },
      stages: [
        { name: "stop-existing-processes", ok: true },
        { name: "launch-anticodex", ok: true },
        { name: "wait-health-ready", ok: true },
      ],
    }), "utf8");
    const result = spawnSync(process.execPath, [resolve(root, "scripts", "summarize-anticodex-report.mjs"), reportPath], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.coldRelaunchEvidence.healthOk, true);
    assert.equal(summary.coldRelaunchEvidence.providerReady, true);
    assert.equal(summary.coldRelaunchEvidence.mode, "antigravity");
    assert.equal(summary.coldRelaunchEvidence.upstream, "antigravity-desktop");
    assert.equal(summary.coldRelaunchEvidence.modelCount, 8);
    assert.equal(summary.coldRelaunchEvidence.mainCount, 1);
    assert.equal(summary.coldRelaunchEvidence.translatorCount, 1);
    assert.equal(summary.coldRelaunchEvidence.launcherCount, 1);
    assert.equal(summary.coldRelaunchEvidence.launcherStarted, true);
    assert.equal(summary.coldRelaunchEvidence.launcherHasExited, true);
    assert.equal(summary.coldRelaunchEvidence.launcherExitCode, 0);
    assert.match(summary.coldRelaunchEvidence.launcherStdoutTail, /launched successfully/);
    assert.equal(summary.coldRelaunchEvidence.originalCodexUnchanged, true);
    assert.equal(summary.coldRelaunchEvidence.stageCount, 3);
    assert.equal(summary.coldRelaunchEvidence.failedStageCount, 0);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("report summarizer surfaces stability soak evidence", () => {
  const tempRoot = mkdtempSync(resolve(os.tmpdir(), "anticodex-stability-soak-summarizer-"));
  const reportPath = resolve(tempRoot, "latest-stability-soak.json");
  try {
    writeFileSync(reportPath, JSON.stringify({
      ok: true,
      reportName: "stability-soak",
      mode: "antigravity",
      model: "gemini-3.5-flash-low",
      providerReady: true,
      startReady: true,
      endReady: true,
      modelCount: 8,
      startPid: 123,
      endPid: 123,
      pidStable: true,
      healthChecks: 5,
      elapsedMs: 45000,
      turns: [
        { name: "cn-1", ok: true },
        { name: "stream", ok: true },
      ],
      failures: [],
    }), "utf8");
    const result = spawnSync(process.execPath, [resolve(root, "scripts", "summarize-anticodex-report.mjs"), reportPath], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.stabilitySoakEvidence.mode, "antigravity");
    assert.equal(summary.stabilitySoakEvidence.model, "gemini-3.5-flash-low");
    assert.equal(summary.stabilitySoakEvidence.providerReady, true);
    assert.equal(summary.stabilitySoakEvidence.startReady, true);
    assert.equal(summary.stabilitySoakEvidence.endReady, true);
    assert.equal(summary.stabilitySoakEvidence.pidStable, true);
    assert.equal(summary.stabilitySoakEvidence.healthChecks, 5);
    assert.equal(summary.stabilitySoakEvidence.turnCount, 2);
    assert.equal(summary.stabilitySoakEvidence.failedTurnCount, 0);
    assert.equal(summary.stabilitySoakEvidence.elapsedMs, 45000);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("report summarizer surfaces optional real-traffic continuity evidence values", () => {
  const tempRoot = mkdtempSync(resolve(os.tmpdir(), "anticodex-optional-real-summarizer-"));
  const providerReport = resolve(tempRoot, "latest-real-third-party-provider.json");
  const antigravityReport = resolve(tempRoot, "latest-provider-antigravity-return.json");
  try {
    writeFileSync(providerReport, JSON.stringify({
      ok: true,
      reportName: "real-third-party-provider",
      skipped: false,
      behaviorCovered: true,
      coverageKind: "real-traffic",
      usedRealTraffic: true,
      firstMarkerObserved: true,
      secondMarkerObserved: false,
      historyContinuationObserved: true,
      routeEvidence: {
        transport: "upstream-provider",
        providerProtocol: "openai-compatible",
        requestedModel: "real-model",
        resolvedModel: "real-model",
        status: "success",
      },
      realProviderToAntigravityReturnEvidence: {
        requested: true,
        realAntigravityTurnUsed: true,
        returnedToAntigravityWithHistory: true,
        previousResponseIdMatched: true,
        markerCount: 3,
        missingMarkerCount: 0,
        returnUpstream: "antigravity-desktop",
        routeTransport: "antigravity-native",
        requestedModel: "gemini-pro-agent",
        resolvedModel: "gemini-pro-agent",
      },
      secretsRedacted: true,
      turns: 3,
    }), "utf8");
    let result = spawnSync(process.execPath, [resolve(root, "scripts", "summarize-anticodex-report.mjs"), providerReport], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    let summary = JSON.parse(result.stdout);
    assert.equal(summary.optionalRealProviderEvidence.firstMarkerObserved, true);
    assert.equal(summary.optionalRealProviderEvidence.secondMarkerObserved, false);
    assert.equal(summary.optionalRealProviderEvidence.historyContinuationObserved, true);
    assert.equal(summary.optionalRealProviderEvidence.routeTransport, "upstream-provider");
    assert.equal(summary.optionalRealProviderEvidence.routeProviderProtocol, "openai-compatible");
    assert.equal(summary.optionalRealProviderEvidence.routeResolvedModel, "real-model");
    assert.equal(summary.optionalRealProviderEvidence.routeStatus, "success");
    assert.equal(summary.optionalRealProviderEvidence.secretsRedacted, true);
    assert.equal(summary.optionalRealProviderEvidence.turns, 3);
    assert.equal(summary.realProviderToAntigravityReturnEvidence.requested, true);
    assert.equal(summary.realProviderToAntigravityReturnEvidence.realAntigravityTurnUsed, true);
    assert.equal(summary.realProviderToAntigravityReturnEvidence.returnedToAntigravityWithHistory, true);
    assert.equal(summary.realProviderToAntigravityReturnEvidence.previousResponseIdMatched, true);
    assert.equal(summary.realProviderToAntigravityReturnEvidence.markerCount, 3);
    assert.equal(summary.realProviderToAntigravityReturnEvidence.missingMarkerCount, 0);
    assert.equal(summary.realProviderToAntigravityReturnEvidence.returnUpstream, "antigravity-desktop");
    assert.equal(summary.realProviderToAntigravityReturnEvidence.routeTransport, "antigravity-native");
    assert.equal(summary.realProviderToAntigravityReturnEvidence.requestedModel, "gemini-pro-agent");
    assert.equal(summary.realProviderToAntigravityReturnEvidence.resolvedModel, "gemini-pro-agent");

    writeFileSync(antigravityReport, JSON.stringify({
      ok: true,
      reportName: "provider-antigravity-return",
      skipped: false,
      behaviorCovered: true,
      coverageKind: "real-traffic",
      usedRealTraffic: true,
      realAntigravityEvidence: {
        requested: true,
        realAntigravityTurnUsed: true,
        returnedToAntigravityWithHistory: false,
        previousResponseIdMatched: true,
        markerCount: 6,
        missingMarkerCount: 1,
        routeTransport: "antigravity-native",
        resolvedModel: "gemini-pro-agent",
      },
    }), "utf8");
    result = spawnSync(process.execPath, [resolve(root, "scripts", "summarize-anticodex-report.mjs"), antigravityReport], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    summary = JSON.parse(result.stdout);
    assert.equal(summary.antigravityReturnEvidence.requested, true);
    assert.equal(summary.antigravityReturnEvidence.realAntigravityTurnUsed, true);
    assert.equal(summary.antigravityReturnEvidence.returnedToAntigravityWithHistory, false);
    assert.equal(summary.antigravityReturnEvidence.previousResponseIdMatched, true);
    assert.equal(summary.antigravityReturnEvidence.markerCount, 6);
    assert.equal(summary.antigravityReturnEvidence.missingMarkerCount, 1);
    assert.equal(summary.antigravityReturnEvidence.routeTransport, "antigravity-native");
    assert.equal(summary.antigravityReturnEvidence.resolvedModel, "gemini-pro-agent");
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("report summarizer surfaces local connector no-traffic evidence values", () => {
  const tempRoot = mkdtempSync(resolve(os.tmpdir(), "anticodex-local-connector-summarizer-"));
  const reportPath = resolve(tempRoot, "latest-local-connectors.json");
  try {
    writeFileSync(reportPath, JSON.stringify({
      ok: true,
      reportName: "local-connectors",
      usedRealTraffic: false,
      behaviorCovered: true,
      coverageKind: "local-fake-provider",
      endpointEvidence: {
        connectors: 4,
        exposedToolsPost: 1,
        exposedToolsGet: 1,
        exposedToolNames: ["linked_tool"],
        linkedConnectorAccessible: true,
        allowlistedConnectorAccessible: false,
        allowlistedConnectorLocallyAllowlisted: true,
        hiddenConnectorAccessible: false,
        chatgptInstallUrlsScrubbed: true,
        linkEndpointsUnsupported: true,
        upstreamRequestsBeforeLocalEndpoints: 1,
        upstreamRequestsAfterLocalEndpoints: 1,
        upstreamRequestsDuringLocalEndpoints: 0,
      },
      connectorParity: {
        contentMatches: true,
        sharedExists: true,
        localExists: true,
        sharedFingerprint: "abc",
        localFingerprint: "abc",
        missingShared: ["missing-connector"],
        extraLocal: ["extra-connector"],
        changedShared: ["changed-connector"],
      },
      appToolParity: {
        contentMatches: true,
        sharedExists: true,
        localExists: true,
        sharedFingerprint: "def",
        localFingerprint: "def",
        missingShared: ["missing-tool"],
        extraLocal: ["extra-tool"],
        changedShared: ["changed-tool"],
      },
      appToolGetPostParity: { contentMatches: true, missingFromGet: [], extraFromGet: [] },
      tempIsolation: {
        codexHome: "C:/Temp/anticodex-local/codex-home",
        stateRoot: "C:/Temp/anticodex-local",
        sharedCodexHome: "C:/Temp/anticodex-local/shared-codex-home",
        sharedHomeUsed: false,
      },
      disclaimer: "This verifies only local metadata projection.",
    }), "utf8");
    const result = spawnSync(process.execPath, [resolve(root, "scripts", "summarize-anticodex-report.mjs"), reportPath], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.reportName, "local-connectors");
    assert.equal(summary.usedRealTraffic, false);
    assert.equal(summary.behaviorCovered, true);
    assert.equal(summary.coverageKind, "local-fake-provider");
    assert.equal(summary.localConnectorEvidence.exposedToolsPost, 1);
    assert.equal(summary.localConnectorEvidence.exposedToolsGet, 1);
    assert.deepEqual(summary.localConnectorEvidence.exposedToolNames, ["linked_tool"]);
    assert.equal(summary.localConnectorEvidence.linkedConnectorAccessible, true);
    assert.equal(summary.localConnectorEvidence.allowlistedConnectorAccessible, false);
    assert.equal(summary.localConnectorEvidence.allowlistedConnectorLocallyAllowlisted, true);
    assert.equal(summary.localConnectorEvidence.hiddenConnectorAccessible, false);
    assert.equal(summary.localConnectorEvidence.upstreamRequestsBeforeLocalEndpoints, 1);
    assert.equal(summary.localConnectorEvidence.upstreamRequestsAfterLocalEndpoints, 1);
    assert.equal(summary.localConnectorEvidence.upstreamRequestsDuringLocalEndpoints, 0);
    assert.equal(summary.localConnectorEvidence.chatgptInstallUrlsScrubbed, true);
    assert.equal(summary.localConnectorEvidence.linkEndpointsUnsupported, true);
    assert.equal(summary.localConnectorEvidence.connectorParityClean, true);
    assert.equal(summary.localConnectorEvidence.connectorSharedExists, true);
    assert.equal(summary.localConnectorEvidence.connectorLocalExists, true);
    assert.equal(summary.localConnectorEvidence.connectorFingerprintMatches, true);
    assert.deepEqual(summary.localConnectorEvidence.connectorParityMissingShared, ["missing-connector"]);
    assert.deepEqual(summary.localConnectorEvidence.connectorParityExtraLocal, ["extra-connector"]);
    assert.deepEqual(summary.localConnectorEvidence.connectorParityChangedShared, ["changed-connector"]);
    assert.equal(summary.localConnectorEvidence.appToolParityClean, true);
    assert.equal(summary.localConnectorEvidence.appToolSharedExists, true);
    assert.equal(summary.localConnectorEvidence.appToolLocalExists, true);
    assert.equal(summary.localConnectorEvidence.appToolFingerprintMatches, true);
    assert.deepEqual(summary.localConnectorEvidence.appToolParityMissingShared, ["missing-tool"]);
    assert.deepEqual(summary.localConnectorEvidence.appToolParityExtraLocal, ["extra-tool"]);
    assert.deepEqual(summary.localConnectorEvidence.appToolParityChangedShared, ["changed-tool"]);
    assert.equal(summary.localConnectorEvidence.appToolGetPostParityClean, true);
    assert.deepEqual(summary.localConnectorEvidence.appToolGetPostMissingFromGet, []);
    assert.deepEqual(summary.localConnectorEvidence.appToolGetPostExtraFromGet, []);
    assert.equal(summary.localConnectorEvidence.tempSharedHomeUsed, false);
    assert.equal(summary.localConnectorEvidence.tempCodexHomeUnderStateRoot, true);
    assert.equal(summary.localConnectorEvidence.tempSharedCodexHomeUnderStateRoot, true);
    assert.equal(summary.localConnectorEvidence.tempCodexHomeDistinctFromShared, true);
    assert.equal(summary.localConnectorEvidence.disclaimer, "This verifies only local metadata projection.");
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("report summarizer surfaces plugin capability parity drift samples", () => {
  const tempRoot = mkdtempSync(resolve(os.tmpdir(), "anticodex-plugin-summarizer-"));
  const reportPath = resolve(tempRoot, "latest-plugin-capabilities.json");
  try {
    writeFileSync(reportPath, JSON.stringify({
      ok: false,
      reportName: "plugin-capabilities",
      failures: ["drift"],
      capabilities: {
        nativeCodexWriteback: false,
        capabilityState: "degraded_no_accessible_connectors",
        degraded: true,
        connectorCount: 3,
        enabledConnectorCount: 2,
        accessibleConnectorCount: 0,
        appToolCount: 0,
        appToolGetCount: 0,
        unattributedAppToolCount: 0,
        unauthorizedAppToolCount: 0,
          appToolsNote: "expected 0: no accessible connectors linked",
          smoke: {
            checked: true,
            endpointProjectionReadable: true,
            callableState: "skipped_no_accessible_connectors",
            connectorCache: {
            checked: true,
            cacheExists: true,
            fileCount: 1,
            sampleReadable: true,
            sampleConnectorCount: 3,
          },
          appToolsCache: {
            checked: true,
            cacheExists: true,
            fileCount: 1,
            sampleReadable: true,
            sampleToolCount: 0,
          },
        },
        connectorParity: {
          checked: true,
          sharedCount: 4,
          localCount: 4,
          missingShared: ["missing-connector"],
          extraLocal: ["extra-connector"],
          changedShared: ["changed-connector"],
        },
        appToolParity: {
          checked: true,
          missingShared: ["missing-tool"],
          extraLocal: ["extra-tool"],
          changedShared: ["changed-tool"],
        },
        appToolGetPostParity: {
          checked: true,
          contentMatches: false,
          missingFromGet: ["post-only-tool"],
          extraFromGet: ["get-only-tool"],
        },
      },
    }), "utf8");
    const result = spawnSync(process.execPath, [resolve(root, "scripts", "summarize-anticodex-report.mjs"), reportPath], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.pluginCapabilityEvidence.nativeCodexWriteback, false);
    assert.equal(summary.pluginCapabilityEvidence.capabilityState, "degraded_no_accessible_connectors");
    assert.equal(summary.pluginCapabilityEvidence.degraded, true);
    assert.equal(summary.pluginCapabilityEvidence.connectorCount, 3);
    assert.equal(summary.pluginCapabilityEvidence.enabledConnectorCount, 2);
    assert.equal(summary.pluginCapabilityEvidence.accessibleConnectorCount, 0);
    assert.equal(summary.pluginCapabilityEvidence.appToolCount, 0);
    assert.equal(summary.pluginCapabilityEvidence.appToolGetCount, 0);
    assert.equal(summary.pluginCapabilityEvidence.appToolsNote, "expected 0: no accessible connectors linked");
    assert.equal(summary.pluginCapabilityEvidence.smokeChecked, true);
    assert.equal(summary.pluginCapabilityEvidence.endpointProjectionReadable, true);
    assert.equal(summary.pluginCapabilityEvidence.callableState, "skipped_no_accessible_connectors");
    assert.equal(summary.pluginCapabilityEvidence.connectorParityChecked, true);
    assert.equal(summary.pluginCapabilityEvidence.connectorParitySharedCount, 4);
    assert.equal(summary.pluginCapabilityEvidence.connectorParityLocalCount, 4);
    assert.equal(summary.pluginCapabilityEvidence.appToolGetPostParityChecked, true);
    assert.equal(summary.pluginCapabilityEvidence.connectorCacheChecked, true);
    assert.equal(summary.pluginCapabilityEvidence.connectorCacheExists, true);
    assert.equal(summary.pluginCapabilityEvidence.connectorCacheFileCount, 1);
    assert.equal(summary.pluginCapabilityEvidence.connectorCacheSampleReadable, true);
    assert.equal(summary.pluginCapabilityEvidence.connectorCacheSampleConnectorCount, 3);
    assert.equal(summary.pluginCapabilityEvidence.appToolsCacheChecked, true);
    assert.equal(summary.pluginCapabilityEvidence.appToolsCacheExists, true);
    assert.equal(summary.pluginCapabilityEvidence.appToolsCacheFileCount, 1);
    assert.equal(summary.pluginCapabilityEvidence.appToolsCacheSampleReadable, true);
    assert.equal(summary.pluginCapabilityEvidence.appToolsCacheSampleToolCount, 0);
    assert.deepEqual(summary.pluginCapabilityEvidence.connectorParityMissingShared, ["missing-connector"]);
    assert.deepEqual(summary.pluginCapabilityEvidence.connectorParityExtraLocal, ["extra-connector"]);
    assert.deepEqual(summary.pluginCapabilityEvidence.connectorParityChangedShared, ["changed-connector"]);
    assert.equal(summary.pluginCapabilityEvidence.connectorParityClean, false);
    assert.deepEqual(summary.pluginCapabilityEvidence.appToolParityMissingShared, ["missing-tool"]);
    assert.equal(summary.pluginCapabilityEvidence.appToolParityChecked, true);
    assert.deepEqual(summary.pluginCapabilityEvidence.appToolParityExtraLocal, ["extra-tool"]);
    assert.deepEqual(summary.pluginCapabilityEvidence.appToolParityChangedShared, ["changed-tool"]);
    assert.equal(summary.pluginCapabilityEvidence.appToolParityClean, false);
    assert.deepEqual(summary.pluginCapabilityEvidence.appToolGetPostMissingFromGet, ["post-only-tool"]);
    assert.deepEqual(summary.pluginCapabilityEvidence.appToolGetPostExtraFromGet, ["get-only-tool"]);
    assert.equal(summary.pluginCapabilityEvidence.appToolGetPostParityContentMatches, false);
    assert.equal(summary.pluginCapabilityEvidence.appToolGetPostParityClean, false);

    const uncheckedReportPath = resolve(tempRoot, "latest-plugin-unchecked.json");
    writeFileSync(uncheckedReportPath, JSON.stringify({
      ok: false,
      reportName: "plugin-capabilities",
      capabilities: {
        smoke: { checked: false, endpointProjectionReadable: false, callableState: "skipped_short_budget" },
        connectorParity: { checked: false, missingShared: [], extraLocal: [], changedShared: [] },
        appToolParity: { checked: false, missingShared: [], extraLocal: [], changedShared: [] },
        appToolGetPostParity: { checked: false, contentMatches: false, missingFromGet: [], extraFromGet: [] },
      },
    }), "utf8");
    const uncheckedResult = spawnSync(process.execPath, [resolve(root, "scripts", "summarize-anticodex-report.mjs"), uncheckedReportPath], { encoding: "utf8" });
    assert.equal(uncheckedResult.status, 0, uncheckedResult.stderr || uncheckedResult.stdout);
    const uncheckedSummary = JSON.parse(uncheckedResult.stdout);
    assert.equal(uncheckedSummary.pluginCapabilityEvidence.smokeChecked, false);
    assert.equal(uncheckedSummary.pluginCapabilityEvidence.endpointProjectionReadable, false);
    assert.equal(uncheckedSummary.pluginCapabilityEvidence.connectorParityChecked, false);
    assert.equal(uncheckedSummary.pluginCapabilityEvidence.connectorParityClean, false);
    assert.equal(uncheckedSummary.pluginCapabilityEvidence.appToolParityChecked, false);
    assert.equal(uncheckedSummary.pluginCapabilityEvidence.appToolParityClean, false);
    assert.equal(uncheckedSummary.pluginCapabilityEvidence.appToolGetPostParityChecked, false);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("report summarizer treats releaseReady false as not effectively passing", () => {
  const tempRoot = mkdtempSync(resolve(os.tmpdir(), "anticodex-release-summary-"));
  const reportPath = resolve(tempRoot, "latest-release-gates.json");
  const nextActions = [{
    id: "postVerification",
    gateId: "postVerification",
    phase: "real-traffic-final",
    command: "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\test-anticodex-post-verification.ps1 -TimeoutMinutes 10",
    reason: "stale_report",
    guidance: "real_traffic_evidence_stale: rerun post verification after approval.",
    requiresRealTraffic: true,
    highImpact: true,
    blockedUntilExplicitUserApproval: true,
  }, ...Array.from({ length: 9 }, (_, index) => ({
    id: `action${index + 2}`,
    gateId: `gate${index + 2}`,
    phase: "real-traffic-low-state",
    command: `command-${index + 2}`,
    requiresGatewayStart: true,
    blockedUntilExplicitUserApproval: true,
  }))];
  try {
    writeFileSync(reportPath, JSON.stringify({
      ok: true,
      reportName: "release-gates",
      shortReady: true,
      releaseReady: false,
      strictOptionalRealTraffic: true,
      optionalRealTrafficReady: false,
      optionalRealTrafficFailures: ["realThirdPartyProviderOptional"],
      missingRequired: ["latest-real-work.json"],
      missingShort: [],
      missingOptional: ["coldRelaunch"],
      damagedReports: [],
      groups: {
        cold: {
          total: 1,
          satisfied: 0,
          required: 0,
          requiredSatisfied: 0,
          optional: 1,
          optionalSatisfied: 0,
          missingRequired: [],
          missingOptional: ["coldRelaunch"],
        },
      },
      gates: [{
        id: "postVerification",
        group: "real-traffic",
        requiredForRelease: true,
        satisfied: false,
        failureReason: "stale_report",
        failureReasons: ["stale_report"],
        ageHours: 56.1,
        fresh: false,
        selectedKind: "latest",
        selectedFile: "latest-post-verification.json",
        selectedMtime: "2026-06-24T01:02:03.000Z",
        reportFailureSamples: ["gateway offline", "health timeout", "third sample", "hidden fourth"],
        orderedActions: [{
          id: "postVerification",
          phase: "real-traffic-final",
          command: "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\test-anticodex-post-verification.ps1 -TimeoutMinutes 10",
          reason: "stale_report",
          guidance: "real_traffic_evidence_stale: rerun post verification after approval.",
          requiresRealTraffic: true,
          highImpact: true,
          blockedUntilExplicitUserApproval: true,
        }],
      }, {
        id: "modelRouting",
        group: "no-traffic",
        requiredForRelease: true,
        satisfied: false,
        failureReason: "semantic_failures",
        failureReasons: ["semantic_failures"],
      }, {
        id: "syncReadiness",
        group: "no-traffic",
        selectedFromHistory: true,
        selectedFile: "20260624-071841-sync-readiness.json",
        satisfied: true,
      }, {
        id: "installedRuntimeSync",
        satisfied: true,
        sourceFingerprint: "source-runtime-fingerprint",
        installedRuntimeFingerprint: "source-runtime-fingerprint",
        sourceFileCount: 58,
        installedRuntimeFileCount: 58,
        sourceMtimeMax: "2026-06-24T00:00:00.000Z",
        installedRuntimeMtimeMax: "2026-06-24T00:00:00.000Z",
        missingSourceFiles: [],
        missingInstalledRuntimeFiles: [],
        mismatchedRuntimeFiles: [],
      }],
      nextActions,
      approvalPlan: {
        actionCount: 1,
        blockedCount: 1,
        requiresGatewayStartCount: 0,
        requiresRealTrafficCount: 1,
        highImpactCount: 1,
        requiredForShortCount: 0,
        requiredForReleaseCount: 1,
        firstBlockedAction: "postVerification",
        phases: [{
          phase: "real-traffic-final",
          count: 1,
          requiresGatewayStart: false,
          requiresRealTraffic: true,
          highImpact: true,
          blockedUntilExplicitUserApproval: true,
        }],
      },
    }), "utf8");
    const result = spawnSync(process.execPath, [resolve(root, "scripts", "summarize-anticodex-report.mjs"), reportPath], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.ok, true);
    assert.equal(summary.effectiveOk, false);
    assert.equal(summary.releaseReady, false);
    assert.equal(summary.strictOptionalRealTraffic, true);
    assert.equal(summary.optionalRealTrafficReady, false);
    assert.deepEqual(summary.optionalRealTrafficFailures, ["realThirdPartyProviderOptional"]);
    assert.deepEqual(summary.missingRequired, ["latest-real-work.json"]);
    assert.deepEqual(summary.missingOptional, ["coldRelaunch"]);
    assert.deepEqual(summary.releaseGateFailureReasons, [{
      id: "postVerification",
      group: "real-traffic",
      requiredForRelease: true,
      requiredForShort: false,
      failureReason: "stale_report",
      failureReasons: ["stale_report"],
      failureReasonsAvailableCount: 1,
      failureReasonsHiddenCount: 0,
      ageHours: 56.1,
      fresh: false,
      selectedFromHistory: false,
      historySourceMismatch: false,
      selectedKind: "latest",
      selectedFile: "latest-post-verification.json",
      selectedMtime: "2026-06-24T01:02:03.000Z",
      reportFailureSamples: ["gateway offline", "health timeout", "third sample"],
      guidance: "",
      orderedActions: [{
        id: "postVerification",
        phase: "real-traffic-final",
        command: "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\test-anticodex-post-verification.ps1 -TimeoutMinutes 10",
        reason: "stale_report",
        guidance: "real_traffic_evidence_stale: rerun post verification after approval.",
        requiresGatewayStart: false,
        requiresRealTraffic: true,
        highImpact: true,
        blockedUntilExplicitUserApproval: true,
      }],
    }, {
      id: "modelRouting",
      group: "no-traffic",
      requiredForRelease: true,
      requiredForShort: false,
      failureReason: "semantic_failures",
      failureReasons: ["semantic_failures"],
      failureReasonsAvailableCount: 1,
      failureReasonsHiddenCount: 0,
      ageHours: null,
      fresh: null,
      selectedFromHistory: false,
      historySourceMismatch: false,
      selectedKind: "",
      selectedFile: "",
      selectedMtime: "",
      reportFailureSamples: [],
      guidance: "",
      orderedActions: [],
    }]);
    assert.equal(summary.nextActions.length, 10);
    assert.deepEqual(summary.nextActions[0], {
      id: "postVerification",
      gateId: "postVerification",
      phase: "real-traffic-final",
      command: "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\test-anticodex-post-verification.ps1 -TimeoutMinutes 10",
      reason: "stale_report",
      guidance: "real_traffic_evidence_stale: rerun post verification after approval.",
      requiresGatewayStart: false,
      requiresRealTraffic: true,
      highImpact: true,
      blockedUntilExplicitUserApproval: true,
    });
    assert.equal(summary.nextActions[9].id, "action10");
    assert.equal(summary.approvalPlan.actionCount, 1);
    assert.equal(summary.approvalPlan.requiresRealTrafficCount, 1);
    assert.equal(summary.approvalPlan.firstBlockedAction, "postVerification");
    assert.deepEqual(summary.releaseGateGroups, [{
      group: "cold",
      total: 1,
      satisfied: 0,
      required: 0,
      requiredSatisfied: 0,
      optional: 1,
      optionalSatisfied: 0,
      missingRequired: [],
      missingOptional: ["coldRelaunch"],
    }]);
    assert.deepEqual(summary.releaseGateSelectedReports, [{
      id: "syncReadiness",
      group: "no-traffic",
      selectedFile: "20260624-071841-sync-readiness.json",
      historySourceMismatch: false,
    }]);
    assert.equal(summary.installedRuntimeEvidence.sourceFileCount, 58);
    assert.equal(summary.installedRuntimeEvidence.installedRuntimeFileCount, 58);
    assert.equal(summary.installedRuntimeEvidence.sourceFingerprint, "source-runtime-fingerprint");
    assert.equal(summary.installedRuntimeEvidence.installedRuntimeFingerprint, "source-runtime-fingerprint");
    assert.deepEqual(summary.installedRuntimeEvidence.mismatchedRuntimeFiles, []);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("strict optional real-traffic gate rejects skipped optional reports", () => {
  const tempRoot = mkdtempSync(resolve(os.tmpdir(), "anticodex-strict-optional-real-"));
  const writeSignedReport = (name, payload) => {
    const text = JSON.stringify(payload);
    const reportPath = resolve(tempRoot, name);
    writeFileSync(reportPath, text, "utf8");
    writeFileSync(`${reportPath}.sha256`, `sha256:${createHash("sha256").update(text).digest("hex")}`, "ascii");
  };
  try {
    mkdirSync(tempRoot, { recursive: true });
    writeSignedReport("latest-real-third-party-provider.json", {
      ok: true,
      reportName: "real-third-party-provider",
      skipped: true,
      requestedRealTraffic: false,
      usedRealTraffic: false,
      behaviorCovered: false,
      coverageKind: "skipped",
    });
    writeSignedReport("latest-provider-antigravity-return.json", {
      ok: true,
      reportName: "provider-antigravity-return",
      skipped: true,
      requestedRealTraffic: false,
      usedRealTraffic: false,
      behaviorCovered: false,
      coverageKind: "skipped",
    });
    const result = spawnSync(process.execPath, [
      resolve(root, "scripts", "test-anticodex-release-gates.mjs"),
      "--report-root", tempRoot,
      "--strict",
      "--strict-optional-real-traffic",
    ], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.strictOptionalRealTraffic, true);
    assert.equal(summary.optionalRealTrafficReady, false);
    assert.ok(summary.optionalRealTrafficFailures.includes("realThirdPartyProviderOptional"));
    assert.ok(summary.optionalRealTrafficFailures.includes("providerAntigravityReturnOptional"));
    assert.equal(summary.releaseReady, false);
    assert.equal(summary.ok, false);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("strict optional real-traffic gate rejects successful reports without requested flag", () => {
  const tempRoot = mkdtempSync(resolve(os.tmpdir(), "anticodex-strict-optional-requested-"));
  const writeSignedReport = (name, payload) => {
    const text = JSON.stringify(payload);
    const reportPath = resolve(tempRoot, name);
    writeFileSync(reportPath, text, "utf8");
    writeFileSync(`${reportPath}.sha256`, `sha256:${createHash("sha256").update(text).digest("hex")}`, "ascii");
  };
  try {
    mkdirSync(tempRoot, { recursive: true });
    writeSignedReport("latest-real-third-party-provider.json", {
      ok: true,
      reportName: "real-third-party-provider",
      skipped: false,
      usedRealTraffic: true,
      behaviorCovered: true,
      coverageKind: "real-traffic",
      firstMarkerObserved: true,
      secondMarkerObserved: true,
      historyContinuationObserved: true,
      secretsRedacted: true,
      turns: 2,
      routeEvidence: {
        transport: "upstream-provider",
        providerProtocol: "openai-compatible",
        requestedModel: "real-model",
        resolvedModel: "real-model",
        status: "success",
      },
    });
    writeSignedReport("latest-provider-antigravity-return.json", {
      ok: true,
      reportName: "provider-antigravity-return",
      skipped: false,
      usedRealTraffic: true,
      behaviorCovered: true,
      coverageKind: "real-traffic",
      realAntigravityEvidence: {
        requested: true,
        realAntigravityTurnUsed: true,
        returnedToAntigravityWithHistory: true,
        previousResponseIdMatched: true,
        markerCount: 6,
        missingMarkerCount: 0,
        routeTransport: "antigravity-native",
        resolvedModel: "gemini-pro",
      },
    });
    const result = spawnSync(process.execPath, [
      resolve(root, "scripts", "test-anticodex-release-gates.mjs"),
      "--report-root", tempRoot,
      "--strict",
      "--strict-optional-real-traffic",
    ], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.strictOptionalRealTraffic, true);
    assert.equal(summary.optionalRealTrafficReady, false);
    assert.ok(summary.optionalRealTrafficFailures.includes("realThirdPartyProviderOptional"));
    assert.ok(summary.optionalRealTrafficFailures.includes("providerAntigravityReturnOptional"));
    assert.ok(summary.gates.find((gate) => gate.id === "realThirdPartyProviderOptional")?.semanticFailures.includes("optional_real_traffic_not_requested"));
    assert.ok(summary.gates.find((gate) => gate.id === "providerAntigravityReturnOptional")?.semanticFailures.includes("optional_real_traffic_not_requested"));
    assert.equal(summary.releaseReady, false);
    assert.equal(summary.ok, false);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("report summarizer preserves all release-gate approval plan phases", () => {
  const tempRoot = mkdtempSync(resolve(os.tmpdir(), "anticodex-release-phases-summary-"));
  const reportPath = resolve(tempRoot, "latest-release-gates.json");
  const phases = [
    "report-only",
    "gateway-start",
    "short-local",
    "short-gateway",
    "plugin-capabilities",
    "manager-gateway-check",
    "no-traffic-source",
    "no-traffic-local-features",
    "no-traffic-runtime-sync",
    "no-traffic-models",
    "no-traffic-overall",
    "real-traffic-low-state",
    "real-traffic-session-state",
    "real-traffic-high-impact",
    "real-traffic-final",
    "optional-stability-soak",
    "optional-cold-relaunch",
  ].map((phase, index) => ({
    phase,
    count: index + 1,
    reportOnly: phase === "report-only",
    blockedUntilExplicitUserApproval: phase !== "report-only",
  }));
  try {
    writeFileSync(reportPath, JSON.stringify({
      ok: false,
      reportName: "release-gates",
      shortReady: false,
      releaseReady: false,
      strictOptionalRealTraffic: false,
      optionalRealTrafficReady: false,
      optionalRealTrafficFailures: [],
      missingRequired: ["postVerification"],
      missingShort: [],
      missingOptional: ["coldRelaunch"],
      damagedReports: [],
      groups: {},
      gates: [],
      nextActions: [],
      approvalPlan: {
        actionCount: phases.length,
        blockedCount: phases.length - 1,
        requiresGatewayStartCount: 0,
        requiresRealTrafficCount: 0,
        highImpactCount: 0,
        reportOnlyCount: 1,
        requiredForShortCount: 0,
        requiredForReleaseCount: phases.length,
        firstBlockedAction: "startGatewayTranslatorOnly",
        phases,
      },
    }), "utf8");
    const result = spawnSync(process.execPath, [resolve(root, "scripts", "summarize-anticodex-report.mjs"), reportPath], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.approvalPlan.phases.length, phases.length);
    assert.equal(summary.approvalPlan.phases.at(-1).phase, "optional-cold-relaunch");
    assert.equal(summary.approvalPlan.phases[0].reportOnly, true);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("Anti-Codex core reports are written as UTF-8 without BOM for Node readers", () => {
  const reportIo = readFileSync(resolve(root, "scripts", "anticodex-report-io.ps1"), "utf8");
  const reportScripts = [
    "collect-anticodex-diagnostics.ps1",
    "drill-anticodex-proxy.ps1",
    "switch-anticodex-account.ps1",
    "test-anticodex-account-proxy-readiness.ps1",
    "test-anticodex-cancellation.ps1",
    "test-anticodex-cold-relaunch.ps1",
    "test-anticodex-compaction-resume.ps1",
    "test-anticodex-custom-tool-loop.ps1",
    "test-anticodex-installed-overall.ps1",
    "test-anticodex-mcp-tool-loop.ps1",
    "test-anticodex-model-routing.ps1",
    "test-anticodex-native-multi-tool-loop.ps1",
    "test-anticodex-native-tool-loop.ps1",
    "test-anticodex-parallel-tool-loop.ps1",
    "test-anticodex-post-verification.ps1",
    "test-anticodex-streaming-parallel-tool-loop.ps1",
    "test-anticodex-sync-readiness.ps1",
    "test-anticodex-tool-bridge-mode.ps1",
    "test-anticodex-tool-loop.ps1",
    "test-anticodex-source-preflight.ps1",
    "test-anticodex-ui-idle-stability.ps1",
    "test-anticodex-web-tools.ps1",
  ];

  assert.match(reportIo, /function Write-AntiCodexTextAtomic/);
  assert.match(reportIo, /function Write-AntiCodexJsonReport/);
  assert.match(reportIo, /UTF8Encoding\(\$false\)/);
  assert.match(reportIo, /ConvertFrom-Json -ErrorAction Stop/);
  assert.match(reportIo, /System\.IO\.File\]::Replace/);
  assert.match(reportIo, /SHA256\]::Create/);
  assert.match(reportIo, /\.sha256/);
  assert.match(reportIo, /ASCIIEncoding/);

  for (const scriptName of reportScripts) {
    const script = readFileSync(resolve(root, "scripts", scriptName), "utf8");
    assert.match(script, /UTF8Encoding(?:\]::new|\(\$false\))/, `${scriptName} should use explicit UTF-8 without BOM`);
    if (scriptName !== "collect-anticodex-diagnostics.ps1") {
      assert.match(script, /Write-AntiCodexJsonReport|Write-AntiCodexTextAtomic/, `${scriptName} should use atomic report writes`);
    }
  }
  const accountProxy = readFileSync(resolve(root, "scripts", "test-anticodex-account-proxy-readiness.ps1"), "utf8");
  assert.match(accountProxy, /latest-account-proxy-readiness\.json/);
  assert.match(accountProxy, /Write-AntiCodexJsonReport/);
  const localConnectors = readFileSync(resolve(root, "scripts", "test-anticodex-local-connectors.mjs"), "utf8");
  const thirdPartyProvider = readFileSync(resolve(root, "scripts", "test-anticodex-third-party-provider.mjs"), "utf8");
  const releaseGates = readFileSync(resolve(root, "scripts", "test-anticodex-release-gates.mjs"), "utf8");
  assert.match(localConnectors, /createHash\("sha256"\)/);
  assert.match(localConnectors, /function writeHashSidecar/);
  assert.match(localConnectors, /\.sha256/);
  assert.match(localConnectors, /chatgptInstallUrlsScrubbed/);
  assert.match(localConnectors, /allowlistedDetail\.installUrl,\s*null/);
  assert.match(localConnectors, /redirect_url/);
  assert.match(thirdPartyProvider, /createHash\("sha256"\)/);
  assert.match(thirdPartyProvider, /function writeHashSidecar/);
  assert.match(thirdPartyProvider, /\.sha256/);
  assert.match(releaseGates, /latest-release-gates\.json/);
  assert.match(releaseGates, /releaseReady/);
  assert.match(releaseGates, /shortReady/);
  assert.match(releaseGates, /function writeHashSidecar/);
  assert.match(releaseGates, /\.sha256/);
  const reportSigner = readFileSync(resolve(root, "scripts", "sign-anticodex-reports.mjs"), "utf8");
  assert.match(reportSigner, /createHash\("sha256"\)/);
  assert.match(reportSigner, /const write = args\.has\("--write"\)/);
  assert.match(reportSigner, /const force = args\.has\("--force"\)/);
  assert.match(reportSigner, /const requireOk = !args\.has\("--allow-not-ok"\)/);
  assert.match(reportSigner, /parsed\.report\.ok !== true/);
  assert.match(reportSigner, /reason: "hash_mismatch"/);
  assert.match(reportSigner, /reason: "invalid_hash_sidecar"/);
  assert.match(reportSigner, /existingHash !== hash && !force/);
  assert.match(reportSigner, /writeFileSync\(sidecar, `sha256:\$\{hash\}`, "ascii"\)/);
  assert.match(reportSigner, /dryRun: !write/);
  assert.match(reportSigner, /latest-post-verification\.json/);
  assert.match(reportSigner, /latest-real-work\.json/);
  const installedOverall = readFileSync(resolve(root, "scripts", "test-anticodex-installed-overall.ps1"), "utf8");
  assert.match(installedOverall, /latest-release-gates\.json/);
  assert.match(installedOverall, /latest-cold-relaunch\.json/);
  assert.match(installedOverall, /latest-diagnostics\.json/);
  assert.match(installedOverall, /latest-account-proxy-readiness\.json/);
  assert.match(installedOverall, /latest-post-verification\.json/);
  assert.match(installedOverall, /latest-model-thinking\.json/);
  assert.match(installedOverall, /latest-source-preflight\.json/);
  assert.match(installedOverall, /latest-real-work\.json/);
  assert.match(installedOverall, /latest-real-mini-tool\.json/);
  assert.match(installedOverall, /latest-real-small-project\.json/);
  assert.match(installedOverall, /latest-native-multi-tool-loop\.json/);
  assert.match(installedOverall, /latest-custom-tool-loop\.json/);
  assert.match(installedOverall, /latest-cancellation\.json/);
  assert.match(installedOverall, /latest-web-tools\.json/);
  assert.match(installedOverall, /latest-shortcut-repair\.json/);
  assert.match(installedOverall, /latest-real-third-party-provider\.json/);
  assert.match(installedOverall, /latest-provider-antigravity-return\.json/);
  assert.match(installedOverall, /latest-third-party-provider\.json/);
});

test("Anti-Codex parsed state and manifest files are written as UTF-8 without BOM", () => {
  const jsonWriters = [
    "check-anticodex-update.ps1",
    "install-anticodex.ps1",
    "sync-anticodex.ps1",
  ];

  for (const scriptName of jsonWriters) {
    const script = readFileSync(resolve(root, "scripts", scriptName), "utf8");
    assert.match(script, /UTF8Encoding\]::new\(\$false\)/, `${scriptName} should write parsed JSON as UTF-8 without BOM`);
    assert.match(script, /WriteAllText/, `${scriptName} should use an explicit .NET text writer for parsed JSON`);
  }
});

test("diagnostics payload includes localFeatures with skills/mcp/snapshots structure", () => {
  const server = readFileSync(resolve(root, "translator", "adaptive-server.mjs"), "utf8");
  const diagnosticsFunc = server.match(/function diagnosticsPayload\(\{[\s\S]*?return \{[\s\S]*?\n    \};/)?.[0];
  assert.ok(diagnosticsFunc, "missing diagnosticsPayload return");
  assert.match(diagnosticsFunc, /localFeatures:\s*fast\s*\?\s*\{\s*skipped:\s*true,\s*reason:\s*"fast_diagnostics"\s*\}\s*:\s*localFeatureSummary\(\{\s*includeProjection:\s*true\s*\}\)/);
  assert.match(diagnosticsFunc, /logDbGuard:\s*fast\s*\?\s*\{\s*skipped:\s*true,\s*reason:\s*"fast_diagnostics"\s*\}\s*:\s*logDbGuardStatus\(\)/);
  assert.match(diagnosticsFunc, /installedChecks/);
  assert.match(diagnosticsFunc, /sourcePreflight/);
  assert.match(diagnosticsFunc, /syncReadinessEvidence/);
  assert.match(diagnosticsFunc, /latest-sync-readiness\.json/);
  assert.match(server, /function logDbGuardStatus/);
  assert.match(server, /protect-anticodex-log-db\.mjs/);
  assert.match(server, /"--status"/);
  assert.match(server, /function latestInstalledCheckStatus/);
  assert.match(server, /function latestSourcePreflightStatus/);
  assert.match(server, /function sourcePreflightSummary/);
  assert.match(server, /antigravityCliProfilePrepareContract/);
  assert.match(server, /antigravityCliIsolationProfileContract/);
  assert.match(server, /profilePrepareContract/);
  assert.match(server, /publicDocumentationOk/);
  assert.match(server, /publicDocumentationClientCopySyncContractOk/);
  assert.match(server, /function installedCheckSummary/);
  assert.match(server, /latest-source-preflight\.json/);
  assert.match(server, /latest-installed-overall-fast\.json/);
  assert.match(server, /上次源码预检/);
  assert.match(server, /源码预检证据/);

  const summaryFunc = server.match(/function localFeatureSummary\([\s\S]*?\n\}/)?.[0];
  assert.ok(summaryFunc, "missing localFeatureSummary function");
  const returnBlock = summaryFunc.match(/return \{[\s\S]*?\n    \};/)?.[0];
  assert.ok(returnBlock, "missing localFeatureSummary return");

  assert.match(returnBlock, /skills:\s*\{/);
  assert.match(returnBlock, /mcp:\s*\{/);
  assert.match(returnBlock, /snapshots:\s*\{/);
  assert.match(returnBlock, /requiredPresent/);
  assert.match(returnBlock, /connectorDirectoryFiles/);
  assert.match(returnBlock, /appToolsCacheFiles/);
  assert.match(returnBlock, /capabilityTiers/);
  assert.match(returnBlock, /readableCount/);
  assert.match(returnBlock, /current-session-tool-list/);
  assert.match(returnBlock, /authorizedCount/);
  assert.match(returnBlock, /remoteAuthorizedCount/);
  assert.match(returnBlock, /localAllowlistedCount/);
  assert.match(returnBlock, /callableToolCount/);
  assert.match(returnBlock, /metadata-only/);
  assert.match(returnBlock, /real-authorized/);
  assert.match(returnBlock, /snapshotStatus/);
  assert.match(returnBlock, /maxAgeHours/);
  assert.match(returnBlock, /sourceMtimeMax/);
  assert.match(returnBlock, /sourceFingerprintPresent/);
  assert.match(returnBlock, /sourceFingerprintComparable/);
  assert.match(returnBlock, /sourceFingerprintMatches/);
  assert.match(returnBlock, /staleReason/);
  assert.match(returnBlock, /count/);
  assert.match(returnBlock, /names/);
});

test("Anti-Codex ships a read-only sync readiness verifier", () => {
  const syncReadiness = readFileSync(resolve(root, "scripts", "test-anticodex-sync-readiness.ps1"), "utf8");
  const overall = readFileSync(resolve(root, "scripts", "test-anticodex-installed-overall.ps1"), "utf8");

  assert.match(syncReadiness, /\[CmdletBinding\(\)\]/);
  assert.match(syncReadiness, /\[switch\]\$Fast/);
  assert.match(syncReadiness, /\[switch\]\$SkipAccountProxyProbe/);
  assert.match(syncReadiness, /\[switch\]\$SkipIconPaletteProbe/);
  assert.match(syncReadiness, /\$FastMaxElapsedMs\s*=\s*30000/);
  assert.match(syncReadiness, /if \(\$Fast\) \{ \$SkipIconPaletteProbe = \$true \}/);
  assert.match(syncReadiness, /clientSyncContract = \[pscustomobject\]@{/);
  assert.match(syncReadiness, /codex-client-copy-plus-anticodex-patches/);
  assert.match(syncReadiness, /guarded-host-sync-then-reapply-anticodex-patches/);
  assert.match(syncReadiness, /nativeClientBehaviorCarriedByHostSync = \$true/);
  assert.match(syncReadiness, /forbidsFeatureByFeatureReimplementation = \$true/);
  assert.match(syncReadiness, /antiCodexPatchScope = @\("branding", "icons", "shortcuts", "isolation", "launcher", "model-adapter"\)/);
  assert.match(syncReadiness, /\$sourceHostHashMatchesActive = /);
  assert.match(syncReadiness, /\$sourceCliHashMatchesActive = /);
  assert.match(syncReadiness, /source-version-adopted-after-host-cli-hash-match/);
  assert.match(syncReadiness, /activeSourcePackageVersionFromMarker/);
  assert.match(syncReadiness, /activeSourcePackageVersionEffectiveReason/);
  assert.match(syncReadiness, /update-status\.json/);
  assert.match(syncReadiness, /fast_cached_update_status/);
  assert.match(syncReadiness, /@{\s*InstallRoot\s*=\s*\$installRoot;\s*NoPersist\s*=\s*\$true\s*}/);
  assert.match(syncReadiness, /sync-anticodex\.ps1/);
  assert.match(syncReadiness, /test-anticodex-host-candidate\.ps1/);
  assert.match(syncReadiness, /install-anticodex\.ps1/);
  assert.match(syncReadiness, /codex-patched-app\.ok/);
  assert.match(syncReadiness, /Anti-Codex\.exe/);
  assert.match(syncReadiness, /host-sync\.lock/);
  assert.match(syncReadiness, /update-candidate/);
  assert.match(syncReadiness, /rollback-host/);
  assert.match(syncReadiness, /rollbackExe/);
  assert.match(syncReadiness, /rollbackAsar/);
  assert.match(syncReadiness, /rollbackCodexCli/);
  assert.match(syncReadiness, /activeHostIcon/);
  assert.match(syncReadiness, /activeAppRootIcon/);
  assert.match(syncReadiness, /rollbackHostIcon/);
  assert.match(syncReadiness, /rollbackAppRootIcon/);
  assert.match(syncReadiness, /hostIconExists/);
  assert.match(syncReadiness, /appRootIconExists/);
  assert.match(syncReadiness, /hostIcon/);
  assert.match(syncReadiness, /appRootIcon/);
  assert.match(syncReadiness, /Test-AntiCodexIconPalette/);
  assert.match(syncReadiness, /pink Codex cloud with white command marks/);
  assert.match(syncReadiness, /hostIconPalette/);
  assert.match(syncReadiness, /appRootIconPalette/);
  assert.match(syncReadiness, /pinkBlobSamples/);
  assert.match(syncReadiness, /whiteCommandSamples/);
  assert.match(syncReadiness, /tealBackgroundSamples/);
  assert.match(syncReadiness, /originalBluePurpleSamples/);
  assert.match(syncReadiness, /frameSizes/);
  assert.match(syncReadiness, /desktopIconRequiredFrameSizes\s*=\s*@\(16,\s*24,\s*32,\s*48,\s*64,\s*128,\s*256\)/);
  assert.match(syncReadiness, /desktop shortcut icon missing required frame size/);
  assert.match(syncReadiness, /rollback host marker schema is invalid/);
  assert.match(syncReadiness, /rollback host marker hash mismatch/);
  assert.match(syncReadiness, /rollback host ProductName/);
  assert.match(syncReadiness, /rollback host FileDescription/);
  assert.match(syncReadiness, /rollback host OriginalFilename/);
  assert.match(syncReadiness, /rollback host is incomplete/);
  assert.match(syncReadiness, /rollback bundled Codex CLI/);
  assert.match(syncReadiness, /rollback host inspection failed/);
  assert.match(syncReadiness, /\$rollbackManifestValid/);
  assert.match(syncReadiness, /\$rollbackProductName/);
  assert.match(syncReadiness, /\$rollbackCodexVersion/);
  assert.match(syncReadiness, /rollbackHost = \[pscustomobject\]/);
  assert.match(syncReadiness, /expectedManagerBridgeBaseUrl\s*=\s*"http:\/\/127\.0\.0\.1:8484"/);
  assert.match(syncReadiness, /allowedManagerBridgeBaseUrls/);
  assert.match(syncReadiness, /GetHostAddresses/);
  assert.match(syncReadiness, /Get-ManagerBridgeBaseUrlFromCommandLine/);
  assert.match(syncReadiness, /hasAllowedBaseUrl/);
  assert.match(syncReadiness, /anticodex-manager-bridge\.mjs/);
  assert.match(syncReadiness, /staleManagerBridgeProcesses/);
  assert.match(syncReadiness, /managerBridge\s*=\s*\[pscustomobject\]/);
  assert.match(syncReadiness, /AntiCodexHostSync/);
  assert.match(syncReadiness, /ANTICODEX_HOST_SYNC_MARKER/);
  assert.match(syncReadiness, /Invoke-AntiCodexPostSyncAcceptance/);
  assert.match(syncReadiness, /test-anticodex-installed-overall\.ps1/);
  assert.match(syncReadiness, /SkipAccountProxyProbe/);
  assert.match(syncReadiness, /post-sync acceptance gate/);
  assert.match(syncReadiness, /start-deepcodex\.ps1/);
  assert.match(syncReadiness, /Start Menu Anti-Codex shortcut does not launch start-anticodex\.ps1/);
  assert.match(syncReadiness, /Desktop Anti-Codex shortcut does not launch start-anticodex\.ps1/);
  assert.match(syncReadiness, /Start Menu Anti-Codex shortcut does not point at the installed runtime start script/);
  assert.match(syncReadiness, /Desktop Anti-Codex shortcut does not point at the installed runtime start script/);
  assert.match(syncReadiness, /startMenuMainShortcutTarget/);
  assert.match(syncReadiness, /desktopMainShortcutTarget/);
  assert.match(syncReadiness, /ANTICODEX_NATIVE_TOOL_BRIDGE/);
  assert.match(syncReadiness, /coworker\/tool bridge disabled by default/);
  assert.match(syncReadiness, /resources\\codex\.exe/);
  assert.match(syncReadiness, /--version/);
  assert.match(syncReadiness, /ProductName/);
  assert.match(syncReadiness, /anticodex-host-manifest-v1/);
  assert.match(syncReadiness, /Get-FileHash/);
  assert.match(syncReadiness, /latest-\$Name\.json/);
  assert.match(overall, /test-anticodex-sync-readiness\.ps1/);
  assert.match(overall, /Sync readiness verification/);

  assert.doesNotMatch(syncReadiness, /Stop-Process/);
  assert.doesNotMatch(syncReadiness, /Start-Process/);
  assert.doesNotMatch(syncReadiness, /Remove-Item/);
  assert.doesNotMatch(syncReadiness, /sync-anticodex\.ps1"\)/);
  assert.doesNotMatch(syncReadiness, /auth\/login|chatgpt\.com/);
});

test("Anti-Codex Manager summarizes Codex drift and sync lifecycle without changing UI chrome", () => {
  const manager = readFileSync(resolve(root, "scripts", "manage-anticodex.ps1"), "utf8");

  assert.match(manager, /function Format-CachedUpdateSummary/);
  assert.match(manager, /function Convert-AntiCodexUpdateOperationText/);
  assert.match(manager, /Get-CachedUpdateStatus/);
  assert.match(manager, /Format-CachedUpdateSummary/);
  assert.match(manager, /Convert-AntiCodexUpdateOperationText/);
  assert.match(manager, /rollbackAvailable/);
  assert.match(manager, /rolled_back/);
  assert.match(manager, /candidate_build/);
  assert.match(manager, /candidate_validation/);
  assert.match(manager, /activation/);
  assert.match(manager, /acceptance/);
  assert.match(manager, /\p{Script=Han}/u);
  assert.match(manager, /Anti-Codex/);
  assert.match(manager, /\$updateSummary/);
  assert.match(manager, /\$operationSummary/);
});

test("Anti-Codex host sync uses a hash-bound manifest and proves critical patch failure safety", () => {
  const installer = readFileSync(resolve(root, "scripts", "install-anticodex.ps1"), "utf8");
  const validator = readFileSync(resolve(root, "scripts", "test-anticodex-host-candidate.ps1"), "utf8");
  const brander = readFileSync(resolve(root, "scripts", "brand-patched-asar.mjs"), "utf8");
  const failureSafety = readFileSync(resolve(root, "scripts", "test-anticodex-sync-failure-safety.ps1"), "utf8");

  assert.match(installer, /Remove-Item\s+-LiteralPath\s+\$hostMarker/);
  assert.match(installer, /anticodex-host-manifest-v1/);
  assert.match(installer, /Get-FileHash/);
  assert.match(installer, /source\s*=\s*\[ordered\]/);
  assert.match(installer, /packageVersion/);
  assert.match(installer, /codexHost/);
  assert.match(installer, /\[IO\.File\]::Move\(\$temporaryMarker,\s*\$marker\)/);
  assert.match(validator, /anticodex-host-manifest-v1/);
  assert.match(validator, /criticalPatches/);
  assert.match(validator, /marker hash mismatch/);
  assert.match(validator, /source Codex fingerprints/);
  assert.match(validator, /FileDescription/);
  assert.match(validator, /OriginalFilename/);
  assert.match(brander, /ANTICODEX_TEST_FAIL_CRITICAL_PATCH/);
  assert.match(brander, /const criticalSkipped = skipped\.filter\(\(item\) => criticalPatchNames\.has\(item\.name\)\)/);
  assert.match(brander, /if \(criticalSkipped\.length > 0\) \{\s*process\.exitCode = 1;\s*\}/);
  assert.match(failureSafety, /Failed candidate retained a valid host marker/);
  assert.match(failureSafety, /failureCauseVerified/);
  assert.match(failureSafety, /Candidate failed before reaching the requested critical patch failure/);
  assert.match(failureSafety, /active host marker/);
  assert.match(failureSafety, /active host/);
});

test("Anti-Codex installer keeps the desktop surface to the launch shortcut only", () => {
  const installer = readFileSync(resolve(root, "scripts", "install-anticodex.ps1"), "utf8");

  assert.match(installer, /Anti-Codex\.lnk/);
  assert.match(installer, /start-anticodex\.ps1/);
  assert.match(installer, /WindowsPowerShell\\v1\.0\\powershell\.exe/);
  assert.doesNotMatch(installer, /Check Anti-Codex\.(lnk|cmd)/);
  assert.doesNotMatch(installer, /Check Anti-Codex Models\.(lnk|cmd)/);
  assert.doesNotMatch(installer, /Switch Anti-Codex Account\.(lnk|cmd)/);
  assert.doesNotMatch(installer, /Drill Anti-Codex Proxy\.(lnk|cmd)/);
  assert.doesNotMatch(installer, /Refresh Anti-Codex Models\.lnk/);
  assert.doesNotMatch(installer, /Sync Anti-Codex\.lnk/);
});

test("Anti-Codex ships an account model refresh script", () => {
  const refresh = readFileSync(resolve(root, "scripts", "refresh-anticodex-models.ps1"), "utf8");

  assert.match(refresh, /ANTICODEX|Anti-Codex/i);
  assert.match(refresh, /Invoke-AntiCodexHotModelRefresh/);
  assert.match(refresh, /function Read-JsonResponseBody/);
  assert.match(refresh, /\/anticodex\/models\/refresh/);
  assert.match(refresh, /Hot model refresh succeeded/);
  assert.match(refresh, /Provider model refresh kept/);
  assert.match(refresh, /Antigravity refresh skipped/);
  assert.match(refresh, /host-sync\.lock/);
  assert.match(refresh, /AntiCodexHostSync/);
  assert.match(refresh, /Get-AntiCodexHostProcesses/);
  assert.match(refresh, /Stop-AntiCodexLaunchers/);
  assert.match(refresh, /AddSeconds\(3\)/);
  assert.match(refresh, /model-refresh\.log/);
  assert.match(refresh, /start-anticodex\.ps1/);
  assert.match(refresh, /Start-Process/);
  assert.match(refresh, /ANTICODEX_FORCE_STARTUP_MODEL_REFRESH\s*=\s*"1"/);
  assert.match(refresh, /\$previousForceStartupModelRefresh/);
  assert.match(refresh, /ANTICODEX_TEST_FORCE_REFRESH_FALLBACK/);
  assert.match(refresh, /WindowStyle Hidden/);
  assert.match(refresh, /AddSeconds\(90\)/);
  assert.match(refresh, /gateway is healthy/);
  assert.doesNotMatch(refresh, /& \$startAntiCodex/);
  assert.doesNotMatch(refresh, /Antigravity\.exe|Codex\.exe/);
});

test("Anti-Codex ships a repeatable restart-refresh fallback verifier", () => {
  const fallback = readFileSync(resolve(root, "scripts", "test-anticodex-refresh-fallback.ps1"), "utf8");

  assert.match(fallback, /refresh-anticodex-models\.ps1/);
  assert.match(fallback, /ANTICODEX_TEST_FORCE_REFRESH_FALLBACK\s*=\s*"1"/);
  assert.match(fallback, /antigravity-model-catalog\.json/);
  assert.match(fallback, /catalogTimestampAfter/);
  assert.match(fallback, /accountReady/);
  assert.match(fallback, /Get-OriginalCodexMainPids/);
});

test("Anti-Codex operational scripts resolve the current local gateway address dynamically", () => {
  const resolver = readFileSync(resolve(root, "scripts", "resolve-anticodex-base-url.ps1"), "utf8");
  const scriptsDir = resolve(root, "scripts");
  const operationalScripts = readdirSync(scriptsDir)
    .filter((name) => name.endsWith(".ps1"))
    .map((name) => [name, readFileSync(resolve(scriptsDir, name), "utf8")])
    .filter(([name, text]) => name !== "anticodex-upstream-profile.ps1" && text.includes("[string]$BaseUrl"));

  assert.match(resolver, /TRANSLATOR_URL/);
  assert.match(resolver, /ANTICODEX_LOCAL_ADDRESS/);
  assert.match(resolver, /127\.0\.0\.1:8484/);
  assert.doesNotMatch(resolver, /Get-NetIPAddress/);
  assert.ok(operationalScripts.length > 10);
  for (const [name, text] of operationalScripts) {
    assert.match(text, /resolve-anticodex-base-url\.ps1/, `${name} must use the shared endpoint resolver`);
    assert.doesNotMatch(text, /192\.168\.1\.2:8484/, `${name} must not pin this machine's current address`);
  }
});

test("Anti-Codex BaseUrl scripts resolve script-relative defaults after parameter binding", () => {
  const scriptsDir = resolve(root, "scripts");
  const scripts = readdirSync(scriptsDir)
    .filter((name) => name.endsWith(".ps1"))
    .map((name) => [name, readFileSync(resolve(scriptsDir, name), "utf8")])
    .filter(([, text]) => text.includes("$BaseUrl"));

  for (const [name, text] of scripts) {
    assert.doesNotMatch(
      text,
      /\[string\]\$BaseUrl\s*=\s*\$\(&\s*\(Join-Path\s+\$PSScriptRoot/,
      `${name} must not use PSScriptRoot inside a parameter default`,
    );
    if (text.includes("resolve-anticodex-base-url.ps1")) {
      assert.match(text, /if \(-not \$BaseUrl\)/, `${name} must resolve an omitted BaseUrl after param binding`);
    }
  }
});

test("Anti-Codex ships a guided account switching script", () => {
  const switchAccount = readFileSync(resolve(root, "scripts", "switch-anticodex-account.ps1"), "utf8");
  const openAccountSwitch = readFileSync(resolve(root, "scripts", "open-antigravity-account-switch.ps1"), "utf8");

  assert.match(switchAccount, /antigravity-desktop\.ps1/);
  assert.match(switchAccount, /Resolve-AntigravityDesktopPath/);
  assert.match(switchAccount, /Get-AntigravityMainProcess/);
  assert.match(switchAccount, /Wait-AntigravityDesktopStable/);
  assert.match(switchAccount, /refresh-anticodex-models\.ps1/);
  assert.match(switchAccount, /test-anticodex-installed-overall\.ps1/);
  assert.match(switchAccount, /test-anticodex-model-routing\.ps1/);
  assert.match(switchAccount, /Get-ModelSnapshot/);
  assert.match(switchAccount, /SHA256/);
  assert.match(switchAccount, /model_catalog_changed/);
  assert.match(switchAccount, /model_catalog_unchanged/);
  assert.match(switchAccount, /account_identity_changed/);
  assert.match(switchAccount, /account_identity_unchanged/);
  assert.match(switchAccount, /cannot prove account identity changed/);
  assert.match(switchAccount, /verified-all-models/);
  assert.match(switchAccount, /latest-model-routing\.json/);
  assert.match(switchAccount, /New-ReportPaths "account-switch"/);
  assert.match(switchAccount, /Save-JsonReport/);
  assert.match(switchAccount, /latest-\$Name\.json/);
  assert.match(switchAccount, /latest-installed-overall\.json/);
  assert.match(switchAccount, /Read-Host/);
  assert.match(switchAccount, /NoPrompt/);
  assert.match(switchAccount, /SkipOpen/);
  assert.match(switchAccount, /SkipFullModelCheck/);
  assert.match(switchAccount, /AllowUnchanged/);
  assert.match(switchAccount, /Antigravity account did not change/);
  assert.match(switchAccount, /ok = \[bool\]\(\$AllowUnchanged -or \$accountChanged\)/);
  assert.match(switchAccount, /Proxy\s+\$null/);

  assert.doesNotMatch(switchAccount, /chatgpt\.com/);
  assert.doesNotMatch(switchAccount, /auth\/login/);
  assert.doesNotMatch(switchAccount, /Stop-Process/);
  assert.doesNotMatch(switchAccount, /Codex\.exe/);

  assert.match(openAccountSwitch, /antigravity-desktop\.ps1/);
  assert.match(openAccountSwitch, /Resolve-AntigravityDesktopPath/);
  assert.match(openAccountSwitch, /Get-AntigravityMainProcess/);
  assert.match(openAccountSwitch, /Wait-AntigravityDesktopStable/);
  assert.match(openAccountSwitch, /Start-Process/);
  assert.match(openAccountSwitch, /SetForegroundWindow/);
  assert.match(openAccountSwitch, /ShowWindowAsync/);
  assert.equal((openAccountSwitch.match(/Start-Process/g) || []).length, 1);
  assert.match(openAccountSwitch, /nextAction/);
  assert.match(openAccountSwitch, /refreshModels/);
  assert.doesNotMatch(openAccountSwitch, /chatgpt\.com|auth\/login|Stop-Process|Codex\.exe/);
});

test("Anti-Codex hot-refreshes its model catalog when the Antigravity account changes", () => {
  const server = readFileSync(resolve(root, "translator", "adaptive-server.mjs"), "utf8");
  const tracker = readFileSync(resolve(root, "translator", "antigravity-account-tracker.mjs"), "utf8");

  assert.match(server, /createAntigravityAccountTracker/);
  assert.match(server, /fetchAntigravityUserStatus/);
  assert.match(server, /hot-refreshed/);
  assert.match(server, /writeJsonAtomic\(ANTIGRAVITY_MODEL_CATALOG_PATH/);
  assert.match(server, /confirmationObservations:\s*2/);
  assert.match(server, /accountTracking/);
  assert.match(server, /changePending/);
  assert.match(tracker, /previousFingerprint/);
  assert.match(tracker, /pendingFingerprint/);
  assert.match(tracker, /pendingObservations/);
});

test("Anti-Codex bounds the shared Antigravity request queue", () => {
  const server = readFileSync(resolve(root, "translator", "adaptive-server.mjs"), "utf8");
  const queue = readFileSync(resolve(root, "translator", "antigravity-request-queue.mjs"), "utf8");
  const sessionLock = readFileSync(resolve(root, "translator", "antigravity-session-lock.mjs"), "utf8");

  assert.match(server, /ANTIGRAVITY_MAX_QUEUED_REQUESTS/);
  assert.match(server, /maxQueued:\s*ANTIGRAVITY_MAX_QUEUED_REQUESTS/);
  assert.match(server, /antigravityQueue:\s*ANTIGRAVITY_REQUEST_QUEUE\.snapshot\(\)/);
  assert.match(server, /antigravitySessionLock:\s*\{/);
  assert.match(server, /\.\.\.ANTIGRAVITY_SESSION_LOCK\.snapshot\(\)/);
  assert.match(server, /resetAction:\s*"resetAntigravitySessionLock"/);
  assert.match(server, /maxQueuedAntigravityRequests/);
  assert.match(server, /activeAntigravityRequests:\s*ACTIVE_ANTIGRAVITY_REQUESTS\.snapshot\(\)/);
  assert.match(server, /ACTIVE_ANTIGRAVITY_REQUESTS\.cancelAll\(\)/);
  assert.match(server, /ANTIGRAVITY_SESSION_LOCK\.cancelAll\(\)/);
  assert.match(server, /SIGTERM/);
  assert.match(server, /DIRECT_ANTIGRAVITY_REQUEST_QUEUE/);
  assert.match(server, /sharedQueue\.run\(runToolLoop/);
  assert.match(sessionLock, /AntigravitySessionBusyError/);
  assert.match(sessionLock, /type\s*=\s*"antigravity_session_busy"/);
  assert.match(sessionLock, /previousResponseId/);
  assert.match(queue, /AntigravityQueueFullError/);
  assert.match(queue, /statusCode\s*=\s*429/);
  assert.match(queue, /type\s*=\s*"antigravity_queue_full"/);
  assert.match(queue, /Promise\.race\(\[taskPromise,\s*abortWait\]\)/);
  assert.match(queue, /taskPromise\.catch\(\(\)\s*=>\s*\{\}\)/);
  assert.match(queue, /cleanupAbortWait/);
  assert.match(queue, /function snapshot\(\)/);
  assert.match(queue, /function cancelAll\(/);
});

test("Anti-Codex ships a guided proxy outage drill", () => {
  const drill = readFileSync(resolve(root, "scripts", "drill-anticodex-proxy.ps1"), "utf8");

  assert.match(drill, /test-anticodex-account-proxy-readiness\.ps1/);
  assert.match(drill, /AllowUnready/);
  assert.match(drill, /SkipOutage/);
  assert.match(drill, /NoPrompt/);
  assert.match(drill, /RecoveryTimeoutSec/);
  assert.match(drill, /New-ReportPaths "proxy-drill"/);
  assert.match(drill, /Save-JsonReport/);
  assert.match(drill, /latest-\$Name\.json/);
  assert.match(drill, /Read-Host/);
  assert.match(drill, /outage/);
  assert.match(drill, /recovery/);
  assert.match(drill, /diagnosis/);

  assert.doesNotMatch(drill, /chatgpt\.com/);
  assert.doesNotMatch(drill, /auth\/login/);
  assert.doesNotMatch(drill, /Stop-Process/);
  assert.doesNotMatch(drill, /Codex\.exe/);
  assert.doesNotMatch(drill, /Antigravity\.exe/);
});

test("Anti-Codex ships a repeatable installed stability soak script", () => {
  const soak = readFileSync(resolve(root, "scripts", "test-anticodex-stability-soak.ps1"), "utf8");

  assert.match(soak, /Invoke-AntiCodexHealth/);
  assert.match(soak, /Resolve-AntiCodexMode/);
  assert.match(soak, /Resolve-AntiCodexTestModel/);
  assert.match(soak, /Test-AntiCodexReadyForTraffic/);
  assert.match(soak, /upstreamProfile\.model/);
  assert.match(soak, /providerReady/);
  assert.match(soak, /Get-AntiCodexTranslatorPid/);
  assert.match(soak, /Invoke-AntiCodexResponse/);
  assert.match(soak, /Invoke-AntiCodexStream/);
  assert.match(soak, /System\.Net\.WebRequest/);
  assert.match(soak, /\$events\.ToArray\(\)/);
  assert.match(soak, /\$turns\.ToArray\(\)/);
  assert.match(soak, /\$failures\.ToArray\(\)/);
  assert.match(soak, /\[Text\.Encoding\]::UTF8\.GetBytes/);
  assert.match(soak, /\/v1\/responses/);
  assert.match(soak, /\/cancel/);
  assert.match(soak, /return ,\[object\[\]\]/);
  assert.match(soak, /LONGCTX_HEAD/);
  assert.match(soak, /Final instruction: return one Chinese sentence containing both/);
  assert.match(soak, /temperature = 0/);
  assert.match(soak, /marker_tool/);
  assert.match(soak, /marker=`"\$toolMarker`"/);
  assert.match(soak, /toolPromptAttempts/);
  assert.match(soak, /<tool_calls><invoke name=`"marker_tool`">/);
  assert.match(soak, /STREAM_MARKER/);
  assert.match(soak, /stream completion missing final marker/);
  assert.match(soak, /pidStable/);
  assert.match(soak, /healthChecks/);
  assert.match(soak, /reportName = "stability-soak"/);
  assert.match(soak, /startReady/);
  assert.match(soak, /endReady/);
  assert.doesNotMatch(soak, /ConvertFrom-Json -Depth/);
  assert.doesNotMatch(soak, /Stop-Process|Codex\.exe|Antigravity\.exe/);
});

test("Anti-Codex ships a repeatable installed streaming cancellation verifier", () => {
  const cancellation = readFileSync(resolve(root, "scripts", "test-anticodex-cancellation.ps1"), "utf8");

  assert.match(cancellation, /Invoke-AntiCodexHealth/);
  assert.match(cancellation, /Resolve-AntiCodexMode/);
  assert.match(cancellation, /Resolve-AntiCodexTestModel/);
  assert.match(cancellation, /upstreamProfile\.model/);
  assert.match(cancellation, /third-party/);
  assert.match(cancellation, /providerReady/);
  assert.match(cancellation, /accountReady/);
  assert.match(cancellation, /System\.Net\.WebRequest/);
  assert.match(cancellation, /\/v1\/responses/);
  assert.match(cancellation, /\/cancel/);
  assert.match(cancellation, /response\.created/);
  assert.match(cancellation, /response\.cancelled/);
  assert.match(cancellation, /response\.completed/);
  assert.match(cancellation, /stream\s*=\s*\$true/);
  assert.match(cancellation, /\[Text\.Encoding\]::UTF8\.GetBytes/);
  assert.match(cancellation, /\$failures\.ToArray\(\)/);
  assert.match(cancellation, /Proxy\s*=\s*\$null/);
  assert.match(cancellation, /ConvertTo-Json/);
  assert.match(cancellation, /exit 1/);
  assert.match(cancellation, /Add-SseEvent/);
  assert.match(cancellation, /\$events\.Add/);
  assert.match(cancellation, /response\.cancelled ID did not match response\.created/);
  assert.match(cancellation, /response\.failed/);
  assert.match(cancellation, /latest-\$Name\.json/);
  assert.match(cancellation, /New-ReportPaths "cancellation"/);
  assert.match(cancellation, /reportName\s*=\s*"cancellation"/);
  assert.match(cancellation, /requestedRealTraffic\s*=\s*\$true/);
  assert.match(cancellation, /usedRealTraffic\s*=\s*\$true/);
  assert.match(cancellation, /behaviorCovered\s*=\s*\(\$failures\.Count -eq 0\)/);
  assert.match(cancellation, /coverageKind\s*=\s*"real-traffic"/);

  assert.doesNotMatch(cancellation, /Stop-Process/);
  assert.doesNotMatch(cancellation, /Codex\.exe/);
  assert.doesNotMatch(cancellation, /Antigravity\.exe/);
  assert.doesNotMatch(cancellation, /chatgpt\.com/);
  assert.doesNotMatch(cancellation, /auth\/login/);
});

test("Anti-Codex ships a repeatable installed tool-loop verifier", () => {
  const toolLoop = readFileSync(resolve(root, "scripts", "test-anticodex-tool-loop.ps1"), "utf8");
  const nativeToolLoop = readFileSync(resolve(root, "scripts", "test-anticodex-native-tool-loop.ps1"), "utf8");
  const nativeMultiToolLoop = readFileSync(resolve(root, "scripts", "test-anticodex-native-multi-tool-loop.ps1"), "utf8");
  const overall = readFileSync(resolve(root, "scripts", "test-anticodex-installed-overall.ps1"), "utf8");

  assert.match(toolLoop, /marker_tool/);
  assert.match(toolLoop, /tool_choice\s*=\s*"required"/);
  assert.match(toolLoop, /function_call_output/);
  assert.match(toolLoop, /previous_response_id/);
  assert.match(toolLoop, /\/anticodex\/model-routes/);
  assert.match(toolLoop, /latest-\$Name\.json/);
  assert.match(toolLoop, /tool-loop/);
  assert.match(toolLoop, /reportName\s*=\s*"tool-loop"/);
  assert.match(toolLoop, /requestedRealTraffic\s*=\s*\$true/);
  assert.match(toolLoop, /usedRealTraffic\s*=\s*\$true/);
  assert.match(toolLoop, /behaviorCovered\s*=\s*\(\$failures\.Count -eq 0\)/);
  assert.match(toolLoop, /coverageKind\s*=\s*"real-traffic"/);
  assert.match(toolLoop, /internalModel/);
  assert.match(toolLoop, /\$route\.transport\s+-ne\s+"cli"[\s\S]*model route missing internal model/);
  assert.match(toolLoop, /Second response did not preserve/);
  assert.match(toolLoop, /Proxy\s+\$null/);
  assert.match(toolLoop, /\[Text\.Encoding\]::UTF8\.GetBytes/);
  assert.match(overall, /test-anticodex-tool-loop\.ps1/);
  assert.match(overall, /test-anticodex-native-tool-loop\.ps1/);
  assert.match(overall, /test-anticodex-native-multi-tool-loop\.ps1/);
  assert.match(overall, /Tool loop verification/);
  assert.match(overall, /\$AllowRealTraffic -and \$SubcheckTimeoutSec -lt 120/);
  assert.match(overall, /\$realTrafficTimeoutSec/);
  assert.match(overall, /\[Math\]::Max\(\$TimeoutSec, 90\)/);
  assert.match(overall, /test-anticodex-compaction-resume\.ps1[\s\S]*"-TimeoutSec", "\$realTrafficTimeoutSec"/);
  assert.match(overall, /test-anticodex-real-mini-tool\.ps1[\s\S]*"-TimeoutSec", "\$realTrafficTimeoutSec"/);
  assert.match(overall, /test-anticodex-real-work\.ps1[\s\S]*"-TimeoutSec", "\$realTrafficTimeoutSec"/);
  assert.match(overall, /test-anticodex-real-small-project\.ps1[\s\S]*"-TimeoutSec", "\$realTrafficTimeoutSec"/);
  assert.match(overall, /\$healthMode -eq "antigravity" -and \$nativeBridgeEnabled/);
  assert.match(nativeToolLoop, /ConvertFrom-JsonEscapedString/);
  assert.match(nativeToolLoop, /\\u8bf7\\u8c03\\u7528 anticodex_native_marker/);
  assert.match(nativeToolLoop, /\\u8bf7\\u7528\\u4e2d\\u6587\\u4e00\\u53e5\\u8bdd/);
  assert.match(nativeToolLoop, /\\u4e00-\\u9fff/);
  assert.match(nativeToolLoop, /DeepCodex\|Deep Codex/);
  assert.match(nativeToolLoop, /reportName\s*=\s*"native-tool-loop"/);
  assert.match(nativeToolLoop, /reason\s*=\s*"native_bridge_disabled"/);
  assert.match(nativeToolLoop, /coverageKind\s*=\s*"native-bridge-disabled"/);
  assert.match(nativeToolLoop, /coveredBy\s*=\s*"codex-owned-tools-model-only"/);
  assert.match(nativeToolLoop, /requestedRealTraffic\s*=\s*\$true/);
  assert.match(nativeToolLoop, /usedRealTraffic\s*=\s*\$true/);
  assert.match(nativeToolLoop, /behaviorCovered\s*=\s*\(\$failures\.Count -eq 0\)/);
  assert.match(nativeToolLoop, /coverageKind\s*=\s*"real-traffic"/);
  assert.match(nativeMultiToolLoop, /reportName\s*=\s*"native-multi-tool-loop"/);
  assert.match(nativeMultiToolLoop, /reason\s*=\s*"native_bridge_disabled"/);
  assert.match(nativeMultiToolLoop, /coverageKind\s*=\s*"native-bridge-disabled"/);
  assert.match(nativeMultiToolLoop, /coveredBy\s*=\s*"codex-owned-tools-model-only"/);
  assert.match(nativeMultiToolLoop, /requestedRealTraffic\s*=\s*\$true/);
  assert.match(nativeMultiToolLoop, /usedRealTraffic\s*=\s*\$true/);
  assert.match(nativeMultiToolLoop, /behaviorCovered\s*=\s*\(\$failures\.Count -eq 0\)/);
  assert.match(nativeMultiToolLoop, /coverageKind\s*=\s*"real-traffic"/);

  // Assert-Route must accept ResponseId and prefer entries/requestId over latest.
  assert.match(toolLoop, /\$ResponseId/);
  assert.match(toolLoop, /\$routePayload\.entries/);
  assert.match(toolLoop, /requestId/);
  assert.match(toolLoop, /Where-Object[\s\S]*requestId[\s\S]*-eq/);
  assert.match(toolLoop, /-ResponseId\s+\$first\.id/);
  assert.match(toolLoop, /-ResponseId\s+\$second\.id/);
  assert.match(toolLoop, /\$matchMode\s*=\s*"requestId"/);
  assert.match(toolLoop, /\$matchMode\s*=\s*"expectedModel"/);
  assert.match(toolLoop, /\$matchMode\s*=\s*"latest"/);
  assert.match(toolLoop, /function Test-RouteAtOrAfter/);
  assert.match(toolLoop, /\[DateTime\]\$RouteFloorAt/);
  assert.match(toolLoop, /-RouteFloorAt\s+\$startedAt/);
  assert.match(toolLoop, /matchMode\s*=\s*\$firstRoute\.matchMode/);
  assert.match(toolLoop, /matchMode\s*=\s*\$secondRoute\.matchMode/);
  // Entries/requestId matching must appear before latest fallback.
  assert.ok(
    toolLoop.indexOf("Where-Object { \$_.requestId") < toolLoop.indexOf("\$routePayload.latest"),
    "entries/requestId matching must precede blind latest fallback",
  );
  assert.ok(
    toolLoop.indexOf("[string]\$_.resolvedModel -eq \$ExpectedModel") < toolLoop.indexOf("\$routePayload.latest"),
    "expected-model matching must precede latest fallback",
  );
  assert.match(toolLoop, /\$second\s*=\s*Invoke-AntiCodexResponse[\s\S]*\$firstRoute\s*=\s*Assert-Route/);

  assert.doesNotMatch(toolLoop, /Stop-Process/);
  assert.doesNotMatch(toolLoop, /Antigravity\.exe/);
  assert.doesNotMatch(toolLoop, /Codex\.exe/);
  assert.doesNotMatch(toolLoop, /chatgpt\.com/);
  assert.doesNotMatch(toolLoop, /auth\/login/);
});

test("Anti-Codex ships a repeatable installed MCP tool-loop verifier", () => {
  const mcpToolLoop = readFileSync(resolve(root, "scripts", "test-anticodex-mcp-tool-loop.ps1"), "utf8");
  const overall = readFileSync(resolve(root, "scripts", "test-anticodex-installed-overall.ps1"), "utf8");

  assert.match(mcpToolLoop, /type\s*=\s*"namespace"/);
  assert.match(mcpToolLoop, /name\s*=\s*"mcp__node_repl__"/);
  assert.match(mcpToolLoop, /name\s*=\s*"js"/);
  assert.match(mcpToolLoop, /mcp__node_repl__js/);
  assert.match(mcpToolLoop, /function_call" -and \$_.name -eq "js"/);
  assert.match(mcpToolLoop, /function_call_output/);
  assert.match(mcpToolLoop, /previous_response_id/);
  assert.match(mcpToolLoop, /Invoke-RealNodeReplMcpResult/);
  assert.match(mcpToolLoop, /anticodex-real-mcp-smoke\.mjs/);
  assert.match(mcpToolLoop, /\$actualMcpOutput/);
  assert.match(mcpToolLoop, /realMcp/);
  assert.match(mcpToolLoop, /\/anticodex\/model-routes/);
  assert.match(mcpToolLoop, /latest-\$Name\.json/);
  assert.match(mcpToolLoop, /mcp-tool-loop/);
  assert.match(mcpToolLoop, /reportName\s*=\s*"mcp-tool-loop"/);
  assert.match(mcpToolLoop, /requestedRealTraffic\s*=\s*\$true/);
  assert.match(mcpToolLoop, /usedRealTraffic\s*=\s*\$true/);
  assert.match(mcpToolLoop, /behaviorCovered\s*=\s*\(\$failures\.Count -eq 0\)/);
  assert.match(mcpToolLoop, /coverageKind\s*=\s*"real-traffic"/);
  assert.match(mcpToolLoop, /internalModel/);
  assert.match(mcpToolLoop, /\$route\.transport\s+-ne\s+"cli"[\s\S]*model route missing internal model/);
  assert.match(mcpToolLoop, /Second response did not preserve the MCP marker/);
  assert.match(mcpToolLoop, /Proxy\s+\$null/);
  assert.match(mcpToolLoop, /\[Text\.Encoding\]::UTF8\.GetBytes/);
  assert.match(overall, /test-anticodex-mcp-tool-loop\.ps1/);
  assert.match(overall, /MCP tool loop verification/);

  assert.doesNotMatch(mcpToolLoop, /Stop-Process/);
  assert.doesNotMatch(mcpToolLoop, /Antigravity\.exe/);
  assert.doesNotMatch(mcpToolLoop, /Codex\.exe/);
  assert.doesNotMatch(mcpToolLoop, /chatgpt\.com/);
  assert.doesNotMatch(mcpToolLoop, /auth\/login/);
});

test("Anti-Codex ships a repeatable installed parallel multi-tool loop verifier", () => {
  const parallelToolLoop = readFileSync(resolve(root, "scripts", "test-anticodex-parallel-tool-loop.ps1"), "utf8");

  assert.match(parallelToolLoop, /marker_tool/);
  assert.match(parallelToolLoop, /echo_tool/);
  assert.match(parallelToolLoop, /tool_choice\s*=\s*"required"/);
  assert.match(parallelToolLoop, /function_call_output/);
  assert.match(parallelToolLoop, /previous_response_id/);
  assert.match(parallelToolLoop, /\/anticodex\/model-routes/);
  assert.match(parallelToolLoop, /latest-\$Name\.json/);
  assert.match(parallelToolLoop, /parallel-tool-loop/);
  assert.match(parallelToolLoop, /internalModel/);
  assert.match(parallelToolLoop, /\$route\.transport\s+-ne\s+"cli"[\s\S]*model route missing internal model/);
  assert.match(parallelToolLoop, /call_ids_unique/);
  assert.match(parallelToolLoop, /arguments_preserved/);
  assert.match(parallelToolLoop, /outputs_returned_in_reverse_order/);
  assert.match(parallelToolLoop, /exactly two function_calls/);
  assert.match(parallelToolLoop, /Second response repeated a tool call/);
  assert.match(parallelToolLoop, /Second response did not preserve marker_tool marker/);
  assert.match(parallelToolLoop, /Second response did not preserve echo_tool text/);
  assert.match(parallelToolLoop, /Proxy\s+\$null/);
  assert.match(parallelToolLoop, /\[Text\.Encoding\]::UTF8\.GetBytes/);

  assert.doesNotMatch(parallelToolLoop, /Stop-Process/);
  assert.doesNotMatch(parallelToolLoop, /Antigravity\.exe/);
  assert.doesNotMatch(parallelToolLoop, /Codex\.exe/);
  assert.doesNotMatch(parallelToolLoop, /chatgpt\.com/);
  assert.doesNotMatch(parallelToolLoop, /auth\/login/);
});

test("Anti-Codex ships a repeatable installed streaming parallel multi-tool loop verifier", () => {
  const streamingParallelToolLoop = readFileSync(resolve(root, "scripts", "test-anticodex-streaming-parallel-tool-loop.ps1"), "utf8");

  assert.match(streamingParallelToolLoop, /marker_tool/);
  assert.match(streamingParallelToolLoop, /echo_tool/);
  assert.match(streamingParallelToolLoop, /tool_choice\s*=\s*"required"/);
  assert.match(streamingParallelToolLoop, /function_call_output/);
  assert.match(streamingParallelToolLoop, /previous_response_id/);
  assert.match(streamingParallelToolLoop, /stream\s*=\s*\$true/);
  assert.match(streamingParallelToolLoop, /\/anticodex\/model-routes/);
  assert.match(streamingParallelToolLoop, /latest-\$Name\.json/);
  assert.match(streamingParallelToolLoop, /streaming-parallel-tool-loop/);
  assert.match(streamingParallelToolLoop, /internalModel/);
  assert.match(streamingParallelToolLoop, /\$route\.transport\s+-ne\s+"cli"[\s\S]*model route missing internal model/);
  assert.match(streamingParallelToolLoop, /call_ids_unique/);
  assert.match(streamingParallelToolLoop, /arguments_preserved/);
  assert.match(streamingParallelToolLoop, /outputs_returned_in_reverse_order/);
  assert.match(streamingParallelToolLoop, /sse_function_call_count/);
  assert.match(streamingParallelToolLoop, /completed_function_call_count/);
  assert.match(streamingParallelToolLoop, /sse_completed_calls_match/);
  assert.match(streamingParallelToolLoop, /no_output_text_leak/);
  assert.match(streamingParallelToolLoop, /exactly two function_call output_item\.done/);
  assert.match(streamingParallelToolLoop, /Second streaming response repeated a tool call/);
  assert.match(streamingParallelToolLoop, /Second streaming response did not preserve marker_tool marker/);
  assert.match(streamingParallelToolLoop, /Second streaming response did not preserve echo_tool text/);
  assert.match(streamingParallelToolLoop, /response\.output_item\.done/);
  assert.match(streamingParallelToolLoop, /response\.completed/);
  assert.match(streamingParallelToolLoop, /Proxy\s+\$null/);
  assert.match(streamingParallelToolLoop, /\[Text\.Encoding\]::UTF8\.GetBytes/);
  assert.match(streamingParallelToolLoop, /System\.Net\.WebRequest/);
  assert.match(streamingParallelToolLoop, /second_round_sse_function_call_events/);
  assert.match(streamingParallelToolLoop, /second_round_no_protocol_leak/);
  assert.match(streamingParallelToolLoop, /second_round_has_output_text/);
  assert.match(streamingParallelToolLoop, /ASSISTANT_TOOL_CALL/);

  assert.doesNotMatch(streamingParallelToolLoop, /Stop-Process/);
  assert.doesNotMatch(streamingParallelToolLoop, /Antigravity\.exe/);
  assert.doesNotMatch(streamingParallelToolLoop, /Codex\.exe/);
  assert.doesNotMatch(streamingParallelToolLoop, /chatgpt\.com/);
  assert.doesNotMatch(streamingParallelToolLoop, /auth\/login/);
});

test("Anti-Codex ships a repeatable installed custom tool-loop verifier", () => {
  const customToolLoop = readFileSync(resolve(root, "scripts", "test-anticodex-custom-tool-loop.ps1"), "utf8");
  const overall = readFileSync(resolve(root, "scripts", "test-anticodex-installed-overall.ps1"), "utf8");

  assert.match(customToolLoop, /type\s*=\s*"custom"/);
  assert.match(customToolLoop, /name\s*=\s*"apply_patch"/);
  assert.match(customToolLoop, /format\s*=\s*@\{/);
  assert.match(customToolLoop, /syntax\s*=\s*"lark"/);
  assert.match(customToolLoop, /\*\*\* Begin Patch/);
  assert.match(customToolLoop, /\*\*\* Add File:/);
  assert.match(customToolLoop, /\*\*\* End Patch/);
  assert.match(customToolLoop, /custom_tool_call" -and \$_.name -eq "apply_patch"/);
  assert.match(customToolLoop, /custom_tool_call_output/);
  assert.match(customToolLoop, /previous_response_id/);
  assert.match(customToolLoop, /inputPreserved/);
  assert.match(customToolLoop, /custom-tool-loop/);
  assert.match(customToolLoop, /reportName\s*=\s*"custom-tool-loop"/);
  assert.match(customToolLoop, /requestedRealTraffic\s*=\s*\$true/);
  assert.match(customToolLoop, /usedRealTraffic\s*=\s*\$true/);
  assert.match(customToolLoop, /behaviorCovered\s*=\s*\(\$failures\.Count -eq 0\)/);
  assert.match(customToolLoop, /coverageKind\s*=\s*"real-traffic"/);
  assert.match(customToolLoop, /\/anticodex\/model-routes/);
  assert.match(customToolLoop, /\$route\.transport\s+-ne\s+"cli"[\s\S]*model route missing internal model/);
  assert.match(customToolLoop, /Proxy\s+\$null/);
  assert.match(customToolLoop, /\[Text\.Encoding\]::UTF8\.GetBytes/);
  assert.match(overall, /test-anticodex-custom-tool-loop\.ps1/);
  assert.match(overall, /Custom\/freeform tool loop verification/);

  assert.doesNotMatch(customToolLoop, /Stop-Process/);
  assert.doesNotMatch(customToolLoop, /Antigravity\.exe/);
  assert.doesNotMatch(customToolLoop, /Codex\.exe/);
  assert.doesNotMatch(customToolLoop, /chatgpt\.com/);
  assert.doesNotMatch(customToolLoop, /auth\/login/);
});

test("Anti-Codex ships a repeatable installed compaction and session resume verifier", () => {
  const compactionResume = readFileSync(resolve(root, "scripts", "test-anticodex-compaction-resume.ps1"), "utf8");
  const webTools = readFileSync(resolve(root, "scripts", "test-anticodex-web-tools.ps1"), "utf8");
  const overall = readFileSync(resolve(root, "scripts", "test-anticodex-installed-overall.ps1"), "utf8");

  assert.match(compactionResume, /\/v1\/responses\/compact/);
  assert.match(compactionResume, /Invoke-AntiCodexCompact/);
  assert.match(compactionResume, /Invoke-AntiCodexResponse/);
  assert.match(compactionResume, /context_compaction/);
  assert.match(compactionResume, /previous_response_id/);
  assert.match(compactionResume, /COMPACT_SEED_/);
  assert.match(compactionResume, /forbidden_compact_tool/);
  assert.match(compactionResume, /Direct compaction resume did not preserve/);
  assert.match(compactionResume, /Chained compaction resume did not preserve/);
  assert.match(compactionResume, /Compact response did not contain a context_compaction output item/);
  assert.match(compactionResume, /Compact response contained .* tool call/);
  assert.match(compactionResume, /Proxy\s+\$null/);
  assert.match(compactionResume, /\[Text\.Encoding\]::UTF8\.GetBytes/);
  assert.match(compactionResume, /latest-.*\.json/);
  assert.match(compactionResume, /compaction-resume/);
  assert.match(compactionResume, /reportName\s*=\s*"compaction-resume"/);
  assert.match(compactionResume, /requestedRealTraffic\s*=\s*\$true/);
  assert.match(compactionResume, /usedRealTraffic\s*=\s*\$true/);
  assert.match(compactionResume, /behaviorCovered\s*=\s*\(\$failures\.Count -eq 0\)/);
  assert.match(compactionResume, /coverageKind\s*=\s*"real-traffic"/);
  assert.match(compactionResume, /ConvertTo-Json/);
  assert.match(compactionResume, /exit 1/);
  assert.match(webTools, /web-tools/);
  assert.match(webTools, /reportName\s*=\s*"web-tools"/);
  assert.match(webTools, /requestedRealTraffic\s*=\s*\$true/);
  assert.match(webTools, /usedRealTraffic\s*=\s*\$true/);
  assert.match(webTools, /behaviorCovered\s*=\s*\(\$failures\.Count -eq 0\)/);
  assert.match(webTools, /coverageKind\s*=\s*"real-traffic"/);
  assert.match(webTools, /Example Domain\|documentation examples\|Avoid use in operations/);
  assert.match(overall, /test-anticodex-compaction-resume\.ps1/);
  assert.match(overall, /Compaction and session resume verification/);
  assert.match(overall, /test-anticodex-cancellation\.ps1/);
  assert.match(overall, /Streaming cancellation verification/);

  assert.doesNotMatch(compactionResume, /Stop-Process/);
  assert.doesNotMatch(compactionResume, /Start-Process/);
  assert.doesNotMatch(compactionResume, /Antigravity\.exe/);
  assert.doesNotMatch(compactionResume, /Codex\.exe/);
  assert.doesNotMatch(compactionResume, /chatgpt\.com/);
  assert.doesNotMatch(compactionResume, /auth\/login/);
});

test("Anti-Codex launcher cooperates with host sync instead of auto-restarting into the old host", () => {
  const launcher = readFileSync(resolve(root, "scripts", "start-deepcodex.ps1"), "utf8");
  const sync = readFileSync(resolve(root, "scripts", "sync-anticodex.ps1"), "utf8");

  assert.match(launcher, /ANTICODEX_HOST_SYNC_MARKER/);
  assert.match(launcher, /Host sync requested; launcher will not auto-restart/i);
  assert.match(launcher, /Test-Path -LiteralPath \$ANTICODEX_HOST_SYNC_MARKER/);
  assert.match(sync, /Set-Content -LiteralPath \$hostSyncMarker/);
  assert.match(sync, /Wait-AntiCodexHostRelease/);
  assert.match(sync, /Anti-Codex host processes did not exit before the sync timeout/);
  assert.match(sync, /Remove-Item -LiteralPath \$hostSyncMarker/);
  assert.match(sync, /Start-Process[\s\S]*\$startAntiCodex/i);
});

test("Windows shared sidecars are imported as local copies", () => {
  const sync = readFileSync(resolve(root, "scripts", "sync-shared-codex-sidecars.mjs"), "utf8");

  assert.match(sync, /ensureLocalCopy/);
  assert.match(sync, /copyDirectoryContents/);
  assert.doesNotMatch(sync, /junction/);
});

test("Anti-Codex source snapshot reuses unchanged cached file hashes", () => {
  const tempRoot = mkdtempSync(join(os.tmpdir(), "anticodex-source-cache-"));
  const sharedHome = join(tempRoot, "shared");
  const agentsSkills = join(tempRoot, "agents-skills");
  const cachePath = join(tempRoot, "source-cache.json");
  mkdirSync(join(sharedHome, "skills", "alpha"), { recursive: true });
  mkdirSync(join(sharedHome, "cache", "codex_app_directory"), { recursive: true });
  mkdirSync(join(sharedHome, "cache", "codex_apps_tools"), { recursive: true });
  mkdirSync(join(agentsSkills, "beta"), { recursive: true });
  writeFileSync(join(sharedHome, "config.toml"), "[mcp_servers.node_repl]\ncommand='node'\n", "utf8");
  writeFileSync(join(sharedHome, "skills", "alpha", "SKILL.md"), "alpha skill\n", "utf8");
  writeFileSync(join(agentsSkills, "beta", "SKILL.md"), "beta skill\n", "utf8");
  writeFileSync(join(sharedHome, "cache", "codex_app_directory", "one.json"), "{\"id\":\"one\"}\n", "utf8");
  writeFileSync(join(sharedHome, "cache", "codex_apps_tools", "one.json"), "{\"tool\":\"one\"}\n", "utf8");
  for (const name of ["AGENTS.md", "DEFAULT_SKILL_ALLOWLIST.md", "RTK.md", "MCP_WORKER_USAGE_GUIDE.md"]) {
    writeFileSync(join(sharedHome, name), `${name}\n`, "utf8");
  }
  try {
    const script = `
      . '${resolve(root, "scripts", "anticodex-source-snapshot.ps1").replaceAll("'", "''")}'
      $first = Get-AntiCodexSourceSnapshot -SharedCodexHome '${sharedHome.replaceAll("'", "''")}' -AgentsSkillsPath '${agentsSkills.replaceAll("'", "''")}' -CachePath '${cachePath.replaceAll("'", "''")}'
      $second = Get-AntiCodexSourceSnapshot -SharedCodexHome '${sharedHome.replaceAll("'", "''")}' -AgentsSkillsPath '${agentsSkills.replaceAll("'", "''")}' -CachePath '${cachePath.replaceAll("'", "''")}'
      [pscustomobject]@{ first = $first; second = $second } | ConvertTo-Json -Depth 8 -Compress
    `;
    const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", script], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout.trim());
    assert.equal(payload.first.fingerprint, payload.second.fingerprint);
    assert.equal(payload.first.fileCount, payload.second.fileCount);
    assert.equal(payload.first.cacheHitCount, 0);
    assert.ok(payload.first.cacheMissCount > 0);
    assert.ok(payload.second.cacheHitCount >= payload.second.fileCount);
    assert.equal(payload.second.cacheMissCount, 0);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("refresh feature summarizer surfaces recovery actions", () => {
  const tempRoot = mkdtempSync(join(os.tmpdir(), "anticodex-refresh-recovery-summary-"));
  const reportPath = join(tempRoot, "latest-refresh-features.json");
  try {
    writeFileSync(reportPath, JSON.stringify({
      ok: false,
      reportName: "refresh-features",
      verifyOnly: false,
      failures: ["local snapshot refresh reported failure"],
      recoveryActions: [{
        id: "refreshFeatures.skillsDirectoryLocked",
        reason: "local skills snapshot refresh was blocked by a Windows directory lock",
        guidance: "Do not treat the partial refresh as release-ready.",
        commands: [
          "powershell.exe -File scripts/refresh-anticodex-local-features.ps1 -VerifyOnly",
          "node scripts/sync-shared-codex-plugin-host.mjs <codexHome> <sharedCodexHome> --startup-snapshots",
        ],
        requiresRealTraffic: false,
      }, {}, {
        id: "refreshFeatures.incomplete",
        commands: ["node missing-guidance.mjs"],
      }],
      connectorParity: { sharedExists: true, localExists: true, contentMatches: true },
      appToolParity: { sharedExists: true, localExists: true, contentMatches: true },
      skills: { exists: true, count: 3, changedExpected: [], changedExpectedDetails: [] },
      guidance: {},
    }), "utf8");
    const result = spawnSync(process.execPath, [resolve(root, "scripts", "summarize-anticodex-report.mjs"), reportPath], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const summary = JSON.parse(result.stdout);
    assert.deepEqual(summary.refreshFeatureEvidence.recoveryActionIds, ["refreshFeatures.skillsDirectoryLocked", "refreshFeatures.incomplete"]);
    assert.equal(summary.refreshFeatureEvidence.recoveryActions.length, 2);
    assert.equal(summary.refreshFeatureEvidence.recoveryActions[0].requiresRealTraffic, false);
    assert.match(summary.refreshFeatureEvidence.recoveryActions[0].commands[0], /-VerifyOnly/);
    assert.match(summary.refreshFeatureEvidence.recoveryActions[0].commands[1], /--startup-snapshots/);
    assert.equal(summary.refreshFeatureEvidence.recoveryActions[1].guidance, "");
    assert.deepEqual(summary.refreshFeatureEvidence.recoveryActions[1].commands, ["node missing-guidance.mjs"]);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("refresh feature recovery actions are sanitized before summary output", () => {
  const tempRoot = mkdtempSync(join(os.tmpdir(), "anticodex-refresh-recovery-sanitize-"));
  const reportPath = join(tempRoot, "latest-refresh-features.json");
  try {
    const longText = "A".repeat(500);
    writeFileSync(reportPath, JSON.stringify({
      ok: false,
      reportName: "refresh-features",
      recoveryActions: [
        { id: "keep.action", reason: "short reason", guidance: "Do this", commands: ["cmd1"], requiresRealTraffic: false, extraField: "drop me" },
        { id: "", reason: "empty id", guidance: "skip", commands: ["cmd2"] },
        { id: "realtraffic.action", reason: "needs traffic", guidance: "Do that", commands: ["cmd3"], requiresRealTraffic: true },
        { id: "many.commands", reason: longText, guidance: longText, commands: Array.from({ length: 10 }, (_, i) => `${longText}-${i}`), requiresRealTraffic: false },
        ...Array.from({ length: 20 }, (_, i) => ({ id: `overflow.${i}`, reason: "x", guidance: "y", commands: ["c"], requiresRealTraffic: false })),
      ],
      connectorParity: { sharedExists: true, localExists: true, contentMatches: true },
      appToolParity: { sharedExists: true, localExists: true, contentMatches: true },
      skills: { exists: true, count: 0, changedExpected: [], changedExpectedDetails: [] },
      guidance: {},
    }), "utf8");
    const result = spawnSync(process.execPath, [resolve(root, "scripts", "summarize-anticodex-report.mjs"), reportPath], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const summary = JSON.parse(result.stdout);
    const actions = summary.refreshFeatureEvidence.recoveryActions;
    assert.equal(actions.length, 8);
    assert.ok(!summary.refreshFeatureEvidence.recoveryActionIds.includes(""));
    assert.equal(actions[0].extraField, undefined);
    assert.equal(actions.find((action) => action.id === "realtraffic.action").requiresRealTraffic, true);
    const many = actions.find((action) => action.id === "many.commands");
    assert.equal(many.commands.length, 4);
    assert.ok(many.reason.length <= 256);
    assert.ok(many.guidance.length <= 256);
    assert.ok(many.commands[0].length <= 256);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("Anti-Codex ships an installed MCP/skills verification script", () => {
  const mcpSkills = readFileSync(resolve(root, "scripts", "test-anticodex-mcp-skills.ps1"), "utf8");
  const realMcpSmoke = readFileSync(resolve(root, "scripts", "anticodex-real-mcp-smoke.mjs"), "utf8");
  const mcpStdioClient = readFileSync(resolve(root, "scripts", "mcp-stdio-client.mjs"), "utf8");
  const refreshLocalFeatures = readFileSync(resolve(root, "scripts", "refresh-anticodex-local-features.ps1"), "utf8");
  const sharedConfigSync = readFileSync(resolve(root, "scripts", "sync-shared-codex-config.mjs"), "utf8");
  const pluginHostSync = readFileSync(resolve(root, "scripts", "sync-shared-codex-plugin-host.mjs"), "utf8");
  const sourceSnapshot = readFileSync(resolve(root, "scripts", "anticodex-source-snapshot.ps1"), "utf8");
  const antigravityCliLogin = readFileSync(resolve(root, "scripts", "start-anticodex-antigravity-cli-login.ps1"), "utf8");
  const antigravityCliWindowsUserLogin = readFileSync(resolve(root, "scripts", "start-anticodex-antigravity-cli-login-windows-user.ps1"), "utf8");
  const adaptiveServer = readFileSync(resolve(root, "translator", "adaptive-server.mjs"), "utf8");

  // Must include health check and MCP/skills endpoints
  assert.match(mcpSkills, /Invoke-AntiCodexHealth/);
  assert.match(mcpSkills, /if \(\$script:shortBudgetMode\) \{\s*\$healthMode = "skipped_short_budget"/);
  assert.match(mcpSkills, /if \(-not \$script:shortBudgetMode\) \{[\s\S]*\/backend-api\/ps\/plugins\/installed[\s\S]*\/backend-api\/wham\/apps[\s\S]*\n\}/);
  assert.match(mcpSkills, /\/backend-api\/ps\/plugins\/installed/);
  assert.match(mcpSkills, /\/backend-api\/plugins\/list/);
  assert.match(mcpSkills, /\/backend-api\/aip\/connectors/);
  assert.match(mcpSkills, /mcp_servers/);
  assert.match(mcpSkills, /node_repl/);
  assert.match(mcpSkills, /skills/);
  assert.match(mcpSkills, /SharedCodexHome/);
  assert.match(mcpSkills, /AgentsSkillsPath/);
  assert.match(mcpSkills, /\.agents\\skills/);
  assert.match(mcpSkills, /agentsSkillNames/);
  assert.match(mcpSkills, /expectedSharedSkillNames/);
  assert.match(mcpSkills, /duplicateSkillNames/);
  assert.match(mcpSkills, /conflictingDuplicateSkillNames/);
  assert.match(mcpSkills, /changedSharedSkillNames/);
  assert.match(mcpSkills, /changedSharedSkillDetails/);
  assert.match(mcpSkills, /Get-DirectoryContentFingerprint/);
  assert.match(mcpSkills, /\$_\.FullName -notmatch '\(\?i\)\[\\\\\/\]\\\.git\(\?:\[\\\\\/\]\|\$\)'/);
  assert.match(mcpSkills, /duplicate skill '\$skillName' differs between shared Codex skills and agents skills/);
  assert.match(mcpSkills, /expectedInheritedSkillNames/);
  assert.match(mcpSkills, /headroom/);
  assert.match(mcpSkills, /context-save/);
  assert.match(mcpSkills, /context-restore/);
  assert.match(mcpSkills, /keep-codex-fast/);
  assert.match(mcpSkills, /shared or agent skill '\$skillName' exists but Anti-Codex local skills copy is missing it/);
  assert.match(mcpSkills, /shared or agent skill '\$skillName' content differs from Anti-Codex local skills copy/);
  assert.doesNotMatch(mcpSkills, /\$skillEntries\s*=\s*@\([^\r\n]*Select-Object -First 50/);
  assert.match(mcpSkills, /function Get-LinkTargetValue/);
  assert.match(mcpSkills, /function Select-LightFileSystemItem/);
  assert.match(mcpSkills, /\$skillSampleEntries\s*=\s*@\(\$skillEntries \| Select-Object -First 50 \| ForEach-Object \{ Select-LightFileSystemItem \$_ \}\)/);
  assert.match(mcpSkills, /sample = @\(\$skillSampleEntries \| Select-Object -First 10\)/);
  assert.doesNotMatch(mcpSkills, /target = if \(\$skillsItem\) \{ \$skillsItem\.Target \}/);
  assert.doesNotMatch(mcpSkills, /cacheTarget = if \(\$connectorDirectoryItem\) \{ \$connectorDirectoryItem\.Target \}/);
  assert.match(mcpSkills, /AGENTS\.md/);
  assert.match(mcpSkills, /DEFAULT_SKILL_ALLOWLIST\.md/);
  assert.match(mcpSkills, /RTK\.md/);
  assert.match(mcpSkills, /MCP_WORKER_USAGE_GUIDE\.md/);
  assert.match(mcpSkills, /\$sharedHash = if \(\$sharedExists\) \{ Get-FileSha256Hex \$sharedGuidance \}/);
  assert.match(mcpSkills, /\$localHash = if \(\$localExists\) \{ Get-FileSha256Hex \$localGuidance \}/);
  assert.match(mcpSkills, /contentMatches = \$contentMatches/);
  assert.match(mcpSkills, /content differs from shared copy/);
  assert.match(mcpSkills, /shared guidance '\$guidanceName' exists but Anti-Codex local copy is missing it/);
  assert.match(mcpSkills, /Anti-Codex guidance '\$guidanceName' should be a local copy, found link type/);
  assert.match(mcpSkills, /cache\\codex_app_directory/);
  assert.match(mcpSkills, /connector endpoint has entries but Anti-Codex local connector cache is missing/);
  assert.match(mcpSkills, /cacheFileCount/);
  assert.match(mcpSkills, /cache\\codex_apps_tools/);
  assert.match(mcpSkills, /app tools endpoint has tools but Anti-Codex local app-tools cache is missing/);
  assert.match(mcpSkills, /deepcodex_app_connectors\.json/);
  assert.match(mcpSkills, /content_matches/);
  assert.match(mcpSkills, /app tools sync registry content does not match shared cache/);
  assert.match(mcpSkills, /shared_tools_fingerprint/);
  assert.match(mcpSkills, /local_tools_fingerprint/);
  assert.match(mcpSkills, /appTools/);
  assert.match(mcpSkills, /Proxy\s*=\s*\$null/);
  assert.match(mcpSkills, /ConvertTo-Json/);
  assert.match(mcpSkills, /snapshotSource = "anticodex-local-copy"/);
  assert.match(mcpSkills, /anticodex-source-snapshot\.ps1/);
  assert.match(mcpSkills, /Get-AntiCodexSourceSnapshot/);
  assert.match(mcpSkills, /sourceSnapshot = \$sourceSnapshot/);
  assert.match(mcpSkills, /\$script:verifierDeadlineUtc = \[DateTime\]::UtcNow\.AddSeconds\(\[Math\]::Max\(1, \$TimeoutSec\)\)/);
  assert.match(mcpSkills, /function Get-RemainingVerifierBudgetMs/);
  assert.match(mcpSkills, /function New-SkippedSourceSnapshot/);
  assert.match(mcpSkills, /skill fingerprint skipped because verifier budget is exhausted/);
  assert.match(mcpSkills, /fingerprintSkipped = \$skillFingerprintSkipped/);
  assert.doesNotMatch(mcpSkills, /MCP real stdio smoke skipped because verifier budget is too short/);
  assert.doesNotMatch(mcpSkills, /MCP real stdio tools\/list skipped because verifier budget is too short/);
  assert.match(mcpSkills, /source snapshot skipped because verifier budget is exhausted/);
  assert.match(mcpSkills, /\(Get-RemainingVerifierBudgetMs\) -lt 5000/);
  assert.doesNotMatch(mcpSkills, /elseif \(Get-RemainingVerifierBudgetMs -lt 5000\)/);
  assert.match(mcpSkills, /\$consoleResult = \[pscustomobject\]@{/);
  assert.match(mcpSkills, /failureCount = \$failures\.Count/);
  assert.match(mcpSkills, /\$consoleResult \| ConvertTo-Json -Depth 6 -Compress/);
  assert.doesNotMatch(mcpSkills, /\$result \| ConvertTo-Json -Depth 8 -Compress/);
  assert.match(mcpSkills, /if \(\$failures\.Count -gt 0\) \{ exit 1 \}/);
  assert.match(mcpSkills, /exit 0/);
  assert.match(mcpSkills, /mcpSkillFileHashCachePath/);
  assert.match(mcpSkills, /mcpSkillFileHashFallbackCachePath/);
  assert.match(mcpSkills, /refresh-feature-file-hashes\.json/);
  assert.match(mcpSkills, /mcpSkillFileHashFallbackHitCount/);
  assert.match(mcpSkills, /fallbackHitCount = \$script:mcpSkillFileHashFallbackHitCount/);
  assert.match(mcpSkills, /hashCache = \[pscustomobject\]/);
  assert.match(mcpSkills, /\$script:shortBudgetMode = \(\$TimeoutSec -lt 8\)/);
  assert.match(mcpSkills, /function Get-PreviousSourceSnapshot/);
  assert.match(mcpSkills, /Get-ChildItem -LiteralPath \$ReportRoot -Filter \$historyPattern/);
  assert.match(mcpSkills, /foreach \(\$historyPattern in @\("\*-mcp-skills\.json", "\*-refresh-features\.json"\)\)/);
  assert.match(mcpSkills, /latest-refresh-features\.json/);
  assert.match(mcpSkills, /\*-refresh-features\.json/);
  assert.match(mcpSkills, /Sort-Object LastWriteTimeUtc -Descending/);
  assert.match(mcpSkills, /reusedFromPreviousReportPath/);
  assert.match(mcpSkills, /reusedFromPreviousReport/);
  assert.match(mcpSkills, /function Get-McpSmokeTimeoutMs/);
  assert.match(mcpSkills, /\[Math\]::Min\(8000,/);
  assert.match(mcpSkills, /function Invoke-NodeJsonWithProcessTimeout/);
  assert.match(mcpSkills, /Start-Process/);
  assert.match(mcpSkills, /WaitForExit/);
  assert.match(mcpSkills, /\.Kill\(\$true\)/);
  assert.match(mcpSkills, /ConvertFrom-Json -ErrorAction Stop/);
  assert.match(mcpSkills, /if \(\$parsed\.PSObject\.Properties\.Name -contains "ok"\) \{ return \$parsed \}/);
  assert.match(mcpSkills, /real MCP smoke process timed out/);
  assert.match(mcpSkills, /timedOut = \$false/);
  assert.match(mcpSkills, /timedOut = \(\[string\]\$_.Exception.Message\) -match "process timed out"/);
  assert.doesNotMatch(mcpSkills, /& \$node @nodeArgs 2>&1/);
  assert.match(sourceSnapshot, /Label "shared-skills"[\s\S]*-HashContent \$true/);
  assert.match(sourceSnapshot, /Label "agents-skills"[\s\S]*-HashContent \$true/);
  assert.match(mcpSkills, /nativeCodexWriteback = \$false/);
  assert.match(mcpSkills, /capabilityState =/);
  assert.match(mcpSkills, /degraded =/);
  assert.match(mcpSkills, /Invoke-RealNodeReplMcpSmoke/);
  assert.match(mcpSkills, /Invoke-RealMcpListSmoke/);
  assert.match(mcpSkills, /Invoke-LocalJsonWithRetry/);
  assert.match(mcpSkills, /function Get-LocalRequestTimeoutSec/);
  assert.match(mcpSkills, /if \(\$script:shortBudgetMode\) \{[\s\S]{0,120}\[Math\]::Min\(2, \$TimeoutSec\)/);
  assert.match(mcpSkills, /\[Math\]::Min\(15, \[int\]\[Math\]::Floor\(\$TimeoutSec \/ 6\)\)/);
  assert.match(mcpSkills, /TimeoutSec = Get-LocalRequestTimeoutSec/);
  assert.match(mcpSkills, /Start-Sleep -Milliseconds/);
  assert.match(mcpSkills, /attempt \$attempt of \$MaxAttempts/);
  assert.match(mcpSkills, /\$MaxAttempts = 2/);
  assert.match(mcpSkills, /anticodex-real-mcp-smoke\.mjs/);
  assert.match(mcpSkills, /realCall = \$mcpRealSmoke/);
  assert.match(mcpSkills, /realList = @\(\$mcpListSmokeChecks\)/);
  assert.match(mcpSkills, /MCP node_repl real stdio tool call failed/);
  assert.match(mcpSkills, /expectedMcpToolNames/);
  assert.match(mcpSkills, /antigravity_start_implementation/);
  assert.match(mcpSkills, /antigravity_health/);
  assert.doesNotMatch(mcpSkills, /antigravity_get_conversation/);
  assert.doesNotMatch(mcpSkills, /antigravity_send_message/);
  assert.match(mcpSkills, /deepseek_start_implementation/);
  assert.match(mcpSkills, /mimo_start_implementation/);
  assert.match(mcpSkills, /mimo_implement_in_workspace/);
  assert.match(mcpSkills, /mimocode_start_implementation/);
  assert.match(mcpSkills, /mimocode_wait_for_job/);
  assert.match(mcpSkills, /deveco_start_implementation/);
  assert.match(mcpSkills, /deveco_tail_job/);
  assert.match(mcpSkills, /opencode_start_implementation/);
  assert.match(mcpSkills, /opencode_cancel_job/);
  assert.match(mcpSkills, /kilo_start_implementation/);
  assert.match(mcpSkills, /kilo_wait_for_job/);
  assert.match(mcpSkills, /missingExpectedTools/);
  assert.match(mcpSkills, /real stdio tools\/list missing expected tools/);
  assert.match(mcpSkills, /real stdio tools\/list failed/);
  assert.match(mcpSkills, /\$sharedConfigPath = Join-Path \$SharedCodexHome "config\.toml"/);
  assert.match(mcpSkills, /function Get-McpServerNamesFromToml/);
  assert.match(mcpSkills, /function Get-McpSectionText/);
  assert.match(mcpSkills, /function Get-McpNestedSectionText/);
  assert.match(mcpSkills, /function Normalize-McpCommandCompareValue/);
  assert.match(mcpSkills, /function Normalize-McpEnvForCompare/);
  assert.match(mcpSkills, /\$ServerName -eq "node_repl"/);
  assert.match(mcpSkills, /changedSharedMcpNames/);
  assert.match(mcpSkills, /changedSharedMcpDetails/);
  assert.match(mcpSkills, /shared MCP server '\$mcpName' config differs in Anti-Codex local config/);
  assert.match(mcpSkills, /\$sharedMcpNames = @\(Get-McpServerNamesFromToml \$sharedConfigText\)/);
  assert.match(mcpSkills, /\$missingSharedMcpNames = @\(\$sharedMcpNames \| Where-Object \{ \$mcpNames -notcontains \$_ \}\)/);
  assert.match(mcpSkills, /shared MCP server '\$mcpName' exists but Anti-Codex local config is missing it/);
  assert.match(mcpSkills, /\$sharedSkillNames = @\(Get-ChildItem -LiteralPath \$sharedSkillsPath -Directory -Force/);
  assert.match(mcpSkills, /\$agentsSkillNames = @\(Get-ChildItem -LiteralPath \$AgentsSkillsPath -Directory -Force/);
  assert.match(mcpSkills, /\$missingSharedSkillNames = @\(\$expectedSharedSkillNames \| Where-Object \{ \$localSkillNames -notcontains \$_ \}\)/);
  assert.match(mcpSkills, /shared or agent skill '\$skillName' exists but Anti-Codex local skills copy is missing it/);
  assert.match(mcpSkills, /sharedCount = \$sharedMcpNames\.Count/);
  assert.match(mcpSkills, /missingShared = \$missingSharedMcpNames/);
  assert.match(mcpSkills, /changedShared = \$changedSharedMcpNames/);
  assert.match(mcpSkills, /changedSharedDetails = @\(\$changedSharedMcpDetails\)/);
  assert.match(mcpSkills, /sharedCount = \$sharedSkillNames\.Count/);
  assert.match(mcpSkills, /agentsCount = \$agentsSkillNames\.Count/);
  assert.match(mcpSkills, /expectedSharedCount = \$expectedSharedSkillNames\.Count/);
  assert.match(mcpSkills, /missingShared = \$missingSharedSkillNames/);
  assert.match(mcpSkills, /changedShared = \$changedSharedSkillNames/);
  assert.match(mcpSkills, /changedSharedDetails = @\(\$changedSharedSkillDetails\)/);
  assert.match(mcpSkills, /duplicateNames = \$duplicateSkillNames/);
  assert.match(mcpSkills, /conflictingDuplicateNames = \$conflictingDuplicateSkillNames/);
  assert.match(mcpSkills, /\$healthMode = "unknown"/);
  assert.match(mcpSkills, /\$healthMode -eq "third-party"/);
  assert.match(mcpSkills, /third-party upstream missing protocol/);
  assert.match(mcpSkills, /third-party upstream missing model/);
  assert.match(mcpSkills, /unknown upstream mode/);
  assert.match(mcpSkills, /mode = \$healthMode/);
  assert.match(realMcpSmoke, /getCodexMcpServerDefinition/);
  assert.match(realMcpSmoke, /runRealMcpSmoke/);
  assert.match(realMcpSmoke, /runRealMcpListSmoke/);
  assert.match(realMcpSmoke, /runMcpStdioCall/);
  assert.match(realMcpSmoke, /runMcpStdioList/);
  assert.match(realMcpSmoke, /list-only/);
  assert.match(realMcpSmoke, /anticodex-real-mcp-smoke-latest\.json/);
  assert.match(mcpStdioClient, /from "node:events"/);
  assert.match(mcpStdioClient, /await Promise\.race\(\[once\(child, "close"\)/);
  assert.match(mcpStdioClient, /child\.stdout\.destroy\(\)/);
  assert.match(mcpStdioClient, /child\.stderr\.destroy\(\)/);
  assert.match(mcpStdioClient, /\.unref\(\)/);
  assert.match(refreshLocalFeatures, /sync-shared-codex-plugin-host\.mjs/);
  assert.match(refreshLocalFeatures, /AgentsSkillsPath/);
  assert.match(refreshLocalFeatures, /\$env:ANTICODEX_EXTRA_SKILLS_ROOTS = \$AgentsSkillsPath/);
  assert.match(refreshLocalFeatures, /\$previousExtraSkillsRoots = \$env:ANTICODEX_EXTRA_SKILLS_ROOTS/);
  assert.match(refreshLocalFeatures, /\.agents\\skills/);
  assert.match(refreshLocalFeatures, /agentsSkillNames/);
  assert.match(refreshLocalFeatures, /function Get-McpServerNamesFromToml/);
  assert.match(refreshLocalFeatures, /Get-McpServerNamesFromToml \$configText/);
  assert.match(refreshLocalFeatures, /-notmatch "\\.tools\\."/);
  assert.match(refreshLocalFeatures, /missingExpectedSkillNames/);
  assert.match(refreshLocalFeatures, /changedExpectedSkillNames/);
  assert.match(refreshLocalFeatures, /changedExpectedSkillDetails/);
  assert.match(refreshLocalFeatures, /shared or agent skill '\$skillName' exists but Anti-Codex local skills copy is missing it/);
  assert.match(refreshLocalFeatures, /shared or agent skill '\$skillName' content differs from Anti-Codex local skills copy/);
  assert.match(refreshLocalFeatures, /sync-shared-codex-config\.mjs/);
  assert.match(refreshLocalFeatures, /sync-shared-codex-sidecars\.mjs/);
  assert.match(refreshLocalFeatures, /shared config refresh failed/);
  assert.match(sharedConfigSync, /function findExistingSiblingCommand/);
  assert.match(sharedConfigSync, /function normalizeMissingWindowsMcpCommand/);
  assert.match(sharedConfigSync, /fs\.existsSync\(command\)/);
  assert.match(sharedConfigSync, /path\.dirname\(versionDir\)/);
  assert.match(sharedConfigSync, /path\.join\(binRoot, entry\.name, commandName\)/);
  assert.match(sharedConfigSync, /normalizeMissingWindowsMcpCommand/);
  assert.match(refreshLocalFeatures, /function Restore-AntiCodexFeatureFlags/);
  assert.match(refreshLocalFeatures, /responses_websockets/);
  assert.match(refreshLocalFeatures, /remote_plugin/);
  assert.match(refreshLocalFeatures, /Anti-Codex feature flag restore failed/);
  assert.match(refreshLocalFeatures, /if \(-not \$VerifyOnly\) \{/);
  assert.match(refreshLocalFeatures, /--local-snapshots/);
  assert.match(refreshLocalFeatures, /mcp_servers/);
  assert.match(refreshLocalFeatures, /node_repl/);
  assert.match(refreshLocalFeatures, /cache\\codex_app_directory/);
  assert.match(refreshLocalFeatures, /cache\\codex_apps_tools/);
  assert.match(refreshLocalFeatures, /function Get-DirectoryContentFingerprint/);
  assert.match(refreshLocalFeatures, /\$_\.FullName -notmatch '\(\?i\)\[\\\\\/\]\\\.git\(\?:\[\\\\\/\]\|\$\)'/);
  assert.match(refreshLocalFeatures, /anticodex-source-snapshot\.ps1/);
  assert.match(refreshLocalFeatures, /Get-AntiCodexSourceSnapshot/);
  assert.match(refreshLocalFeatures, /sourceSnapshot = \$sourceSnapshot/);
  assert.match(refreshLocalFeatures, /recoveryActions = \$recoveryActions\.ToArray\(\)/);
  assert.match(refreshLocalFeatures, /function Test-SkillsSnapshotLockFailure/);
  assert.match(refreshLocalFeatures, /refreshFeatures\.skillsDirectoryLocked/);
  assert.match(refreshLocalFeatures, /refresh-anticodex-local-features\.ps1 -VerifyOnly/);
  assert.match(refreshLocalFeatures, /sync-shared-codex-plugin-host\.mjs <codexHome> <sharedCodexHome> --startup-snapshots/);
  assert.match(refreshLocalFeatures, /requiresRealTraffic = \$false/);
  assert.match(refreshLocalFeatures, /copy-failed/);
  assert.match(refreshLocalFeatures, /Do not treat the partial refresh as release-ready/);
  assert.match(refreshLocalFeatures, /connectorParity/);
  assert.match(refreshLocalFeatures, /appToolParity/);
  assert.match(refreshLocalFeatures, /New-DirectoryContentDiff/);
  assert.match(refreshLocalFeatures, /missingSharedSample/);
  assert.match(refreshLocalFeatures, /changedSharedSample/);
  assert.match(refreshLocalFeatures, /connector directory local snapshot differs from shared source after refresh/);
  assert.match(refreshLocalFeatures, /app-tools cache local snapshot differs from shared source after refresh/);
  assert.match(refreshLocalFeatures, /skills local copy is empty or missing/);
  assert.match(refreshLocalFeatures, /function Get-FileInfo/);
  assert.match(refreshLocalFeatures, /AGENTS\.md/);
  assert.match(refreshLocalFeatures, /DEFAULT_SKILL_ALLOWLIST\.md/);
  assert.match(refreshLocalFeatures, /RTK\.md/);
  assert.match(refreshLocalFeatures, /MCP_WORKER_USAGE_GUIDE\.md/);
  assert.match(refreshLocalFeatures, /shared guidance '\$name' exists but Anti-Codex local copy is missing/);
  assert.match(refreshLocalFeatures, /shared guidance '\$name' content differs from Anti-Codex local copy/);
  assert.match(refreshLocalFeatures, /contentMatches/);
  assert.match(refreshLocalFeatures, /function Get-LinkTargetValue/);
  assert.doesNotMatch(refreshLocalFeatures, /target = if \(\$item\) \{ \$item\.Target \}/);
  assert.match(refreshLocalFeatures, /ConvertTo-Json/);
  assert.match(antigravityCliLogin, /prepare-anticodex-antigravity-cli-profile\.ps1/);
  assert.match(antigravityCliLogin, /\[switch\]\$DryRun/);
  assert.match(antigravityCliLogin, /\[switch\]\$AllowFileIsolationOnly/);
  assert.match(antigravityCliLogin, /capturesLoginOutput = \$false/);
  assert.match(antigravityCliLogin, /blockedByDefault = \(-not \$AllowFileIsolationOnly\.IsPresent\)/);
  assert.match(antigravityCliLogin, /same Windows user can reuse Antigravity credentials/);
  assert.match(antigravityCliLogin, /windowsCredentialStoreIsolation = \$false/);
  assert.match(antigravityCliLogin, /file-and-appdata-only/);
  assert.match(antigravityCliLogin, /-WorkingDirectory \$profileRootFull/);
  assert.match(antigravityCliLogin, /-ArgumentList \$terminalArgs/);
  assert.match(antigravityCliLogin, /-File/);
  assert.match(antigravityCliLogin, /strictWindowsAppDataIsolation = \$true/);
  assert.doesNotMatch(antigravityCliLogin, /-Command/);
  assert.doesNotMatch(antigravityCliLogin, /RedirectStandardOutput/);
  assert.doesNotMatch(antigravityCliLogin, /Start-Transcript/);
  assert.match(antigravityCliWindowsUserLogin, /runas\.exe/);
  assert.match(antigravityCliWindowsUserLogin, /separate-windows-user/);
  assert.match(antigravityCliWindowsUserLogin, /expectedCredentialStoreIsolation = \$true/);
  assert.match(antigravityCliWindowsUserLogin, /password is handled by Windows runas, not by Codex/);
  assert.match(antigravityCliWindowsUserLogin, /function Get-LocalWindowsUserReadiness/);
  assert.match(antigravityCliWindowsUserLogin, /targetUserExists/);
  assert.match(antigravityCliWindowsUserLogin, /targetUserIsCurrentUser/);
  assert.match(antigravityCliWindowsUserLogin, /readyForInteractiveLogin/);
  assert.match(antigravityCliWindowsUserLogin, /-AllowFileIsolationOnly/);
  assert.match(antigravityCliWindowsUserLogin, /\[switch\]\$DryRun/);
  assert.match(antigravityCliWindowsUserLogin, /capturesLoginOutput = \$false/);
  assert.doesNotMatch(antigravityCliWindowsUserLogin, /Start-Transcript/);
  assert.doesNotMatch(antigravityCliWindowsUserLogin, /RedirectStandardOutput/);
  assert.match(pluginHostSync, /ANTICODEX_EXTRA_SKILLS_ROOTS/);
  assert.match(pluginHostSync, /extraSkillsRoots/);
  assert.match(pluginHostSync, /agentsSkillsPath/);
  assert.match(pluginHostSync, /\.agents', 'skills'/);
  assert.match(pluginHostSync, /extraSharedPaths/);
  assert.match(pluginHostSync, /computeCombinedSnapshotManifest/);
  assert.match(adaptiveServer, /function defaultExtraSkillsRoots/);
  assert.match(adaptiveServer, /function markerExtraSkillsRootInfo/);
  assert.match(adaptiveServer, /function managerActionArgs/);
  assert.match(adaptiveServer, /mcpSkills:[\s\S]{0,180}script: "test-anticodex-mcp-skills\.ps1"[\s\S]{0,80}args: \["-TimeoutSec", "120"\]/);
  assert.match(adaptiveServer, /pluginCapabilities:[\s\S]{0,180}script: "test-anticodex-plugin-capabilities\.ps1"[\s\S]{0,80}args: \["-TimeoutSec", "120"\]/);
  assert.match(adaptiveServer, /ANTICODEX_EXTRA_SKILLS_ROOTS/);
  assert.match(adaptiveServer, /\.agents", "skills"/);
  assert.match(adaptiveServer, /extraSkillsRootsSource/);
  assert.match(adaptiveServer, /-AgentsSkillsPath/);

  // Must NOT reference ChatGPT login or kill processes
  assert.doesNotMatch(mcpSkills, /Stop-Process/);
  assert.doesNotMatch(mcpSkills, /Codex\.exe/);
  assert.doesNotMatch(mcpSkills, /Antigravity\.exe/);
  assert.doesNotMatch(mcpSkills, /chatgpt\.com/);
  assert.doesNotMatch(mcpSkills, /auth\/login/);
  assert.doesNotMatch(refreshLocalFeatures, /Stop-Process/);
  assert.doesNotMatch(refreshLocalFeatures, /Codex\.exe/);
  assert.doesNotMatch(refreshLocalFeatures, /Antigravity\.exe/);
  assert.doesNotMatch(refreshLocalFeatures, /chatgpt\.com/);
  assert.doesNotMatch(refreshLocalFeatures, /auth\/login/);

  // 鈹€鈹€ Retry safety: backoff is tightly bounded for local transient only 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
  assert.match(mcpSkills, /Math\]::Min\(1000,\s*250\s*\*\s*\$attempt\)/,
    "retry backoff must be capped at 1000ms to avoid masking persistent failures");
  assert.match(mcpSkills, /\[\s*int\s*\]\$TimeoutSec\s*=\s*8/,
    "each individual request must have a bounded timeout to limit total retry duration");
});

test("installed MCP/skills verifier fails on missing shared entries without counting comments or subtables", async () => {
  const tempRoot = mkdtempSync(resolve(os.tmpdir(), "anticodex-mcp-skills-verifier-"));
  const localHome = resolve(tempRoot, "local");
  const sharedHome = resolve(tempRoot, "shared");
  const installRoot = resolve(tempRoot, "install");
  const stateRoot = resolve(tempRoot, "state");
  const fakeMcpScript = resolve(localHome, "fake-node-repl.mjs").replace(/\\/g, "/");
  const fakeServerScript = resolve(tempRoot, "fake-verifier-server.mjs");
  const skillNames = ["headroom", "context-save", "context-restore", "keep-codex-fast"];
  let fakeServer;

  try {
    for (const base of [localHome, sharedHome]) {
      for (const skillName of skillNames) {
        const skillDir = resolve(base, "skills", skillName);
        mkdirSync(skillDir, { recursive: true });
        writeFileSync(resolve(skillDir, "SKILL.md"), `# ${skillName}\n`);
      }
    }
    mkdirSync(resolve(sharedHome, "skills", "missing-skill"), { recursive: true });
    writeFileSync(resolve(sharedHome, "skills", "missing-skill", "SKILL.md"), "# missing\n");
    mkdirSync(resolve(tempRoot, "agents-skills", "headroom"), { recursive: true });
    writeFileSync(resolve(tempRoot, "agents-skills", "headroom", "SKILL.md"), "# conflicting headroom\n");
    mkdirSync(localHome, { recursive: true });
    writeFileSync(resolve(localHome, "fake-node-repl.mjs"), "process.stdin.resume();\n");
    writeFileSync(resolve(localHome, "config.toml"), `
[mcp_servers]
# [mcp_servers.local-commented]
[mcp_servers.node_repl]
command = "node"
args = ["${fakeMcpScript}"]
[mcp_servers.node_repl.env]
TOKEN = "local"
[mcp_servers.local-only.tools.nope]
description = "ignored"
`);
    writeFileSync(resolve(sharedHome, "config.toml"), `
[mcp_servers]
# [mcp_servers.commented-out]
[mcp_servers.node_repl]
command = "node"
args = ["${fakeMcpScript}", "--shared"]
[mcp_servers.node_repl.env]
TOKEN = "shared"
[mcp_servers.missing-worker]
command = "node"
args = ["${fakeMcpScript}"]
[mcp_servers.ignored.env]
TOKEN = "ignored"
[mcp_servers.ignored.tools.call]
description = "ignored"
`);
    for (const guidanceName of ["AGENTS.md", "DEFAULT_SKILL_ALLOWLIST.md", "RTK.md", "MCP_WORKER_USAGE_GUIDE.md"]) {
      writeFileSync(resolve(sharedHome, guidanceName), `shared ${guidanceName}\n`);
      writeFileSync(resolve(localHome, guidanceName), guidanceName === "RTK.md" ? "stale local RTK\n" : `shared ${guidanceName}\n`);
    }
    mkdirSync(resolve(localHome, "cache", "codex_apps_tools"), { recursive: true });
    writeFileSync(resolve(localHome, "cache", "codex_apps_tools", "tools.json"), "{}");
    writeFileSync(resolve(localHome, "cache", "deepcodex_app_connectors.json"), JSON.stringify({
      content_matches: false,
      shared_tools_file_count: 2,
      local_tools_file_count: 1,
      shared_tools_fingerprint: "shared-fingerprint",
      local_tools_fingerprint: "local-fingerprint",
    }));
    const reportRoot = resolve(stateRoot, "reports");
    mkdirSync(reportRoot, { recursive: true });
    writeFileSync(resolve(reportRoot, "latest-mcp-skills.json"), JSON.stringify({
      ok: false,
      shortBudgetMode: true,
      sourceSnapshot: { skipped: true, fingerprint: "", fileCount: 0 },
    }), "utf8");
    writeFileSync(resolve(reportRoot, "20260624-000001-mcp-skills.json"), JSON.stringify({
      ok: true,
      shortBudgetMode: false,
      sourceSnapshot: {
        fingerprint: "history-source-fingerprint",
        fileCount: 42,
        cacheHitCount: 40,
        cacheMissCount: 2,
      },
    }), "utf8");
    writeFileSync(fakeServerScript, `
import http from "node:http";
const server = http.createServer((req, res) => {
  req.resume();
  res.writeHead(200, { "content-type": "application/json" });
  if (req.url === "/health") {
    res.end(JSON.stringify({ ok: true, upstream: "antigravity-desktop", accountReady: true, accountState: "ready", modelCount: 1 }));
  } else if (req.url === "/backend-api/plugins/list") {
    res.end(JSON.stringify({ plugins: [] }));
  } else if (req.url === "/backend-api/aip/connectors") {
    res.end(JSON.stringify({ connectors: [] }));
  } else if (req.url === "/backend-api/wham/apps") {
    res.end(JSON.stringify({ apps: [] }));
  } else {
    res.end(JSON.stringify([]));
  }
});
server.listen(0, "127.0.0.1", () => console.log("http://127.0.0.1:" + server.address().port));
`);

    fakeServer = spawn(process.execPath, [fakeServerScript], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const baseUrl = await waitForServerUrl(fakeServer);
    const powershell = process.platform === "win32" ? "powershell.exe" : "pwsh";
    const verifierArgs = [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      resolve(root, "scripts", "test-anticodex-mcp-skills.ps1"),
      "-BaseUrl",
      baseUrl,
      "-InstallRoot",
      installRoot,
      "-StateRoot",
      stateRoot,
      "-CodexHome",
      localHome,
      "-SharedCodexHome",
      sharedHome,
      "-AgentsSkillsPath",
      resolve(tempRoot, "agents-skills"),
      "-TimeoutSec",
      "5",
    ];
    const result = spawnSync(powershell, verifierArgs, { encoding: "utf8", windowsHide: true });
    const fakeMcpNeedle = fakeMcpScript.toLowerCase();
    const tempRootNeedle = tempRoot.replace(/\\/g, "/").toLowerCase();
    const leftoverProcesses = listWindowsProcesses().filter((item) => {
      const commandLine = String(item.CommandLine || "").replace(/\\/g, "/").toLowerCase();
      return commandLine.includes(fakeMcpNeedle)
        || (commandLine.includes("test-anticodex-mcp-skills.ps1") && commandLine.includes(tempRootNeedle));
    });
    assert.deepEqual(
      leftoverProcesses.map((item) => ({ processId: item.ProcessId, commandLine: item.CommandLine })),
      [],
      "MCP/skills short-budget verifier must not leave its fake MCP or exact verifier child process running",
    );
    const processOutput = [result.stdout, result.stderr]
      .filter((value) => typeof value === "string" && value.trim())
      .join("\n");
    assert.ok(processOutput, result.error?.message || "MCP/skills verifier produced no output");
    const output = processOutput.trim().split(/\r?\n/).at(-1);
    const report = JSON.parse(output);

    assert.notEqual(result.status, 0, "intentional missing shared entries should fail the verifier");
    assert.equal(report.shortBudgetMode, true);
    assert.equal(report.sourceSnapshot.fingerprint, "history-source-fingerprint");
    assert.equal(report.sourceSnapshot.fileCount, 42);
    assert.equal(report.sourceSnapshot.reusedFromPreviousReport, true);
    assert.match(report.sourceSnapshot.reusedFromPreviousReportPath, /20260624-000001-mcp-skills\.json/);
    assert.deepEqual(report.mcp.missingShared, ["missing-worker"]);
    assert.deepEqual(report.mcp.changedShared, ["node_repl"]);
    assert.deepEqual(report.mcp.changedSharedDetails[0].fields, ["args"]);
    assert.deepEqual(report.skills.missingShared, ["missing-skill"]);
    assert.deepEqual(report.skills.duplicateNames, ["headroom"]);
    assert.deepEqual(report.skills.conflictingDuplicateNames, ["headroom"]);
    const rtkGuidance = report.guidance.find((entry) => entry.name === "RTK.md");
    assert.equal(rtkGuidance.sharedExists, true);
    assert.equal(rtkGuidance.localExists, true);
    assert.equal(rtkGuidance.contentMatches, false);
    assert.ok(report.failures.some((failure) => failure.includes("shared MCP server 'missing-worker'")));
    assert.ok(report.failures.some((failure) => failure.includes("shared MCP server 'node_repl' config differs")));
    assert.ok(report.failures.some((failure) => failure.includes("shared or agent skill 'missing-skill'")));
    assert.ok(report.failures.some((failure) => failure.includes("duplicate skill 'headroom' differs")));
    assert.ok(report.failures.some((failure) => failure.includes("Anti-Codex guidance 'RTK.md' content differs from shared copy")));
    assert.ok(report.failures.some((failure) => failure.includes("app tools sync registry content does not match shared cache")));
    assert.ok(report.failures.some((failure) => failure.includes("app tools sync registry fingerprint mismatch")));
    assert.equal(report.appTools.registry.contentMatches, false);
    assert.equal(report.appTools.registry.sharedFingerprint, "shared-fingerprint");
    assert.equal(report.appTools.registry.localFingerprint, "local-fingerprint");
    assert.ok(!report.mcp.sharedNames.includes("commented-out"));
    assert.ok(!report.mcp.sharedNames.includes("ignored.env"));
    assert.ok(!report.mcp.sharedNames.includes("ignored.tools.call"));
    assert.ok(!report.mcp.names.includes("local-commented"));
    assert.ok(!report.mcp.names.includes("local-only.tools.nope"));

    writeFileSync(resolve(reportRoot, "latest-mcp-skills.json"), JSON.stringify({
      ok: false,
      shortBudgetMode: true,
      sourceSnapshot: { skipped: true, fingerprint: "", fileCount: 0 },
    }), "utf8");
    writeFileSync(resolve(reportRoot, "20260624-000001-mcp-skills.json"), JSON.stringify({
      ok: false,
      shortBudgetMode: true,
      sourceSnapshot: { skipped: true, fingerprint: "", fileCount: 0 },
    }), "utf8");
    writeFileSync(resolve(reportRoot, "latest-refresh-features.json"), JSON.stringify({
      ok: true,
      reportName: "refresh-features",
      sourceSnapshot: {
        fingerprint: "refresh-source-fingerprint",
        fileCount: 84,
        cacheHitCount: 80,
        cacheMissCount: 4,
      },
    }), "utf8");
    const refreshFallbackResult = spawnSync(powershell, verifierArgs, { encoding: "utf8", windowsHide: true });
    const refreshFallbackOutput = [refreshFallbackResult.stdout, refreshFallbackResult.stderr]
      .filter((value) => typeof value === "string" && value.trim())
      .join("\n");
    assert.ok(refreshFallbackOutput, refreshFallbackResult.error?.message || "MCP/skills refresh fallback run produced no output");
    const refreshFallbackReport = JSON.parse(refreshFallbackOutput.trim().split(/\r?\n/).at(-1));
    assert.equal(refreshFallbackReport.sourceSnapshot.fingerprint, "refresh-source-fingerprint");
    assert.equal(refreshFallbackReport.sourceSnapshot.fileCount, 84);
    assert.equal(refreshFallbackReport.sourceSnapshot.reusedFromPreviousReport, true);
    assert.match(refreshFallbackReport.sourceSnapshot.reusedFromPreviousReportPath, /latest-refresh-features\.json/);
  } finally {
    fakeServer?.kill();
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("Anti-Codex ships a read-only independence verifier", () => {
  const independence = readFileSync(resolve(root, "scripts", "test-anticodex-independence.ps1"), "utf8");
  const overall = readFileSync(resolve(root, "scripts", "test-anticodex-installed-overall.ps1"), "utf8");

  assert.match(independence, /cache\\codex_app_directory/);
  assert.match(independence, /cache\\codex_apps_tools/);
  assert.match(independence, /RequiredLocalCopy/);
  assert.match(independence, /remainingSharedLinks/);
  assert.match(independence, /runtime snapshots must be local directories/);
  assert.match(independence, /function Get-LinkTargetValue/);
  assert.match(independence, /\$target = Get-LinkTargetValue \$item/);
  assert.doesNotMatch(independence, /\$target = \$item\.Target/);
  assert.doesNotMatch(independence, /Allowed shared links are staged import\/update dependencies/);
  assert.match(overall, /test-anticodex-independence\.ps1/);
  assert.match(overall, /Independence verification/);

  assert.doesNotMatch(independence, /Stop-Process/);
  assert.doesNotMatch(independence, /Codex\.exe/);
  assert.doesNotMatch(independence, /chatgpt\.com/);
});

test("Anti-Codex ships a tool bridge mode verifier", () => {
  const bridge = readFileSync(resolve(root, "scripts", "test-anticodex-tool-bridge-mode.ps1"), "utf8");
  const diagnostics = readFileSync(resolve(root, "scripts", "test-anticodex-diagnostics.ps1"), "utf8");
  const overall = readFileSync(resolve(root, "scripts", "test-anticodex-installed-overall.ps1"), "utf8");
  const start = readFileSync(resolve(root, "scripts", "start-deepcodex.ps1"), "utf8");

  assert.match(bridge, /\/anticodex\/diagnostics/);
  assert.match(bridge, /codex-owned-tools-model-only/);
  assert.match(bridge, /codex_owned_model_only_tool_bridge/);
  assert.match(bridge, /native-mcp-same-cascade/);
  assert.match(bridge, /automatic-before-codex-execution/);
  assert.match(bridge, /nativeBridgeDefaultEnabled/);
  assert.match(bridge, /nativeAntigravityToolEvents/);
  assert.match(bridge, /acceptsExternalToolDefinitions/);
  assert.match(bridge, /test-anticodex-native-tool-loop\.ps1/);
  assert.match(bridge, /test-anticodex-native-tool-loop\.ps1/);
  assert.match(start, /ANTICODEX_NATIVE_TOOL_BRIDGE/);
  assert.match(start, /ANTICODEX_ANTIGRAVITY_TRANSPORT\s*=\s*"cli"/);
  assert.match(start, /ANTICODEX_ANTIGRAVITY_CLI_PROFILE_ROOT/);
  assert.match(start, /antigravity-cli-profile/);
  assert.match(start, /ANTICODEX_NATIVE_TOOL_BRIDGE\s*=\s*"0"/);
  assert.match(overall, /ANTICODEX_NATIVE_TOOL_BRIDGE -eq "1"/);
  assert.match(diagnostics, /toolBridge\.mode/);
  assert.match(diagnostics, /native Antigravity tool events/i);
  assert.match(bridge, /\[int\]\$TimeoutSec = 20/);
  assert.match(bridge, /function Get-RemainingVerifierBudgetMs/);
  assert.match(bridge, /verifier budget exhausted before \$Path request attempt \$attempt/);
  assert.match(bridge, /\$requestTimeoutSec = \[Math\]::Max\(1, \[Math\]::Min\(30, \[Math\]::Min\(\$TimeoutSec/);
  assert.match(bridge, /TimeoutSec \$requestTimeoutSec/);
  assert.match(diagnostics, /\[int\]\$TimeoutSec = 20/);
  assert.match(bridge, /Start-Sleep -Milliseconds/);
  assert.match(diagnostics, /Start-Sleep -Milliseconds/);
  assert.match(bridge, /attempt \$attempt of \$MaxAttempts/);
  assert.match(diagnostics, /attempt \$attempt of \$MaxAttempts/);
  assert.match(overall, /test-anticodex-tool-bridge-mode\.ps1/);
  assert.match(overall, /Tool bridge mode verification/);
  assert.match(overall, /\$checks\.toolBridgeMode = if \(\$healthMode -eq "third-party"\)/);
  assert.match(overall, /\$diagnosticScriptArgs = @\("-BaseUrl", \$BaseUrl, "-TimeoutSec", "\$DiagnosticsTimeoutSec"\)/);
  assert.match(overall, /No-traffic model routing verification[\s\S]*"-TimeoutSec", "\$DiagnosticsTimeoutSec"/);
  assert.match(overall, /elseif \(\$Fast\)/);
  assert.match(overall, /Fast tool bridge verification/);
  assert.match(
    overall,
    /\[int\]\$DiagnosticsTimeoutSec\s*=\s*60[\s\S]*\/anticodex\/diagnostics[\s\S]*\$DiagnosticsTimeoutSec/,
  );

  assert.doesNotMatch(bridge, /Stop-Process/);
  assert.doesNotMatch(bridge, /Codex\.exe/);
  assert.doesNotMatch(bridge, /Antigravity\.exe/);
  assert.doesNotMatch(bridge, /chatgpt\.com/);
  assert.doesNotMatch(bridge, /auth\/login/);
});

test("Anti-Codex ships a repeatable plugin/connector capability grading script", () => {
  const capabilities = readFileSync(resolve(root, "scripts", "test-anticodex-plugin-capabilities.ps1"), "utf8");

  // Plugin and connector API endpoints
  assert.match(capabilities, /\/backend-api\/ps\/plugins\/installed/);
  assert.match(capabilities, /\/backend-api\/plugins\/list/);
  assert.match(capabilities, /\/backend-api\/aip\/connectors/);
  assert.match(capabilities, /\/backend-api\/wham\/apps/);

  // Capability metrics
  assert.match(capabilities, /installedPluginCount/);
  assert.match(capabilities, /pluginsWithSkills/);
  assert.match(capabilities, /pluginsWithApps/);
  assert.match(capabilities, /pluginsWithMcpServers/);
  assert.match(capabilities, /connectorCount/);
  assert.match(capabilities, /connectorParity/);
  assert.match(capabilities, /function Get-ProjectionMap/);
  assert.match(capabilities, /changedShared = \$changedShared/);
  assert.match(capabilities, /shared connector '\$connectorId' exists but Anti-Codex local connector cache is missing it/);
  assert.match(capabilities, /local connector cache has extra connector/);
  assert.match(capabilities, /shared connector '\$connectorId' content differs from Anti-Codex local connector cache/);
  assert.match(capabilities, /appToolCount/);
  assert.match(capabilities, /appToolGetCount/);
  assert.match(capabilities, /appToolGetPostParity/);
  assert.match(capabilities, /contentMatches = \(@\(\$missingFromWhamGet\)\.Count -eq 0 -and @\(\$extraFromWhamGet\)\.Count -eq 0\)/);
  assert.match(capabilities, /GET \/backend-api\/wham\/apps does not match POST tool projection/);
  assert.match(capabilities, /appToolParity/);
  assert.match(capabilities, /shared app tool '\$toolKey' exists but Anti-Codex local app-tools cache is missing it/);
  assert.match(capabilities, /local app-tools cache has extra app tool/);
  assert.match(capabilities, /shared app tool '\$toolKey' content differs from Anti-Codex local app-tools cache/);
  assert.match(capabilities, /unattributedAppToolCount/);
  assert.match(capabilities, /unauthorizedAppToolCount/);
  assert.match(capabilities, /app tools exposed without any accessible connector; refusing fake callable capability/);
  assert.match(capabilities, /app tools exposed without connector_id attribution; refusing fake callable capability/);
  assert.match(capabilities, /app tools exposed for connector_id outside accessible connectors; refusing fake callable capability/);
  assert.match(capabilities, /snapshotSource = "anticodex-local-copy"/);
  assert.match(capabilities, /anticodex-source-snapshot\.ps1/);
  assert.match(capabilities, /Get-AntiCodexSourceSnapshot/);
  assert.match(capabilities, /sourceSnapshot = \$sourceSnapshot/);
  assert.match(capabilities, /\$script:shortBudgetMode = \(\$TimeoutSec -lt 5\)/);
  assert.match(capabilities, /function Get-RemainingVerifierBudgetMs/);
  assert.match(capabilities, /\$remainingBudgetMs = Get-RemainingVerifierBudgetMs/);
  assert.match(capabilities, /verifier budget exhausted before \$Path request attempt \$attempt/);
  assert.match(capabilities, /\$requestTimeoutSec = \[Math\]::Max\(1, \[Math\]::Min\(3, \[Math\]::Min\(\$TimeoutSec/);
  assert.match(capabilities, /TimeoutSec = \$requestTimeoutSec/);
  assert.match(capabilities, /Write-PluginCapabilityReport/);
  assert.match(capabilities, /reusedFromPreviousReport/);
  assert.match(capabilities, /plugin capability verification budget exhausted before local parity scan/);
  assert.match(capabilities, /source snapshot refresh skipped because plugin capability verifier budget was exhausted/);
  assert.match(capabilities, /degraded_timeout_budget/);
  assert.match(capabilities, /skipped_timeout_budget/);
  assert.match(capabilities, /degraded_short_budget/);
  assert.match(capabilities, /nativeCodexWriteback = \$false/);
  assert.match(capabilities, /capabilityState =/);
  assert.match(capabilities, /degraded =/);
  assert.match(capabilities, /\.anticodex-source-manifest\.json/);
  assert.match(capabilities, /dataFileCount/);

  // Health verification must work in both Antigravity and third-party modes.
  assert.match(capabilities, /\$healthMode = "unknown"/);
  assert.match(capabilities, /\$healthMode -eq "third-party"/);
  assert.match(capabilities, /third-party upstream missing protocol/);
  assert.match(capabilities, /third-party upstream missing model/);
  assert.match(capabilities, /unknown upstream mode/);
  assert.match(capabilities, /mode = \$healthMode/);

  // HTTP proxy and JSON serialization
  assert.match(capabilities, /Proxy\s*=\s*\$null/);
  assert.match(capabilities, /ConvertTo-Json/);
  assert.match(capabilities, /Invoke-LocalJsonWithRetry/);
  assert.match(capabilities, /Start-Sleep -Milliseconds/);
  assert.match(capabilities, /attempt \$attempt of \$MaxAttempts/);
  assert.match(capabilities, /\$MaxAttempts = 2/);

  // Must NOT reference process killing, host executables, or auth routes
  assert.doesNotMatch(capabilities, /Stop-Process/);
  assert.doesNotMatch(capabilities, /Codex\.exe/);
  assert.doesNotMatch(capabilities, /Antigravity\.exe/);
  assert.doesNotMatch(capabilities, /auth\/login/);
});

test("plugin capability verifier writes a short-budget degraded report", () => {
  const tempRoot = mkdtempSync(resolve(os.tmpdir(), "anticodex-plugin-short-"));
  const previousReportPath = resolve(tempRoot, "latest-plugin-capabilities.json");
  try {
    writeFileSync(previousReportPath, JSON.stringify({
      ok: true,
      reportName: "plugin-capabilities",
      sourceSnapshot: {
        fingerprint: "previous-plugin-source",
        fileCount: 42,
        sourceMtimeMax: "2026-06-24T00:00:00.000Z",
      },
    }), "utf8");
    const startedAt = Date.now();
    const result = spawnSync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy", "Bypass",
      "-File", resolve(root, "scripts", "test-anticodex-plugin-capabilities.ps1"),
      "-TimeoutSec", "3",
      "-BaseUrl", "http://127.0.0.1:9",
      "-ReportRoot", tempRoot,
    ], { encoding: "utf8", timeout: 10000 });
    const elapsedMs = Date.now() - startedAt;
    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.ok(elapsedMs < 8000, `short-budget verifier took ${elapsedMs}ms`);
    const report = JSON.parse(readFileSync(previousReportPath, "utf8"));
    assert.equal(report.ok, false);
    assert.equal(report.shortBudgetMode, true);
    assert.equal(report.sourceSnapshot.fingerprint, "previous-plugin-source");
    assert.equal(report.sourceSnapshot.reusedFromPreviousReport, true);
    assert.match(report.sourceSnapshot.refreshSkippedReason, /short-budget plugin capability/);
    assert.equal(report.capabilities.nativeCodexWriteback, false);
    assert.equal(report.capabilities.capabilityState, "degraded_short_budget");
    assert.equal(report.capabilities.degraded, true);
    assert.equal(report.capabilities.smoke.checked, false);
    assert.equal(report.capabilities.smoke.callableState, "skipped_short_budget");
    assert.equal(report.capabilities.smoke.endpointProjectionReadable, false);
    assert.equal(report.capabilities.connectorParity.checked, false);
    assert.equal(report.capabilities.appToolParity.checked, false);
    assert.equal(report.capabilities.appToolGetPostParity.checked, false);
    assert.equal(report.capabilities.appToolGetPostParity.contentMatches, false);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("plugin capability verifier writes a timeout-budget degraded report", () => {
  const tempRoot = mkdtempSync(resolve(os.tmpdir(), "anticodex-plugin-timeout-budget-"));
  const previousReportPath = resolve(tempRoot, "latest-plugin-capabilities.json");
  try {
    writeFileSync(previousReportPath, JSON.stringify({
      ok: true,
      reportName: "plugin-capabilities",
      sourceSnapshot: {
        fingerprint: "previous-plugin-source",
        fileCount: 42,
        sourceMtimeMax: "2026-06-24T00:00:00.000Z",
      },
    }), "utf8");
    const startedAt = Date.now();
    const result = spawnSync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy", "Bypass",
      "-File", resolve(root, "scripts", "test-anticodex-plugin-capabilities.ps1"),
      "-TimeoutSec", "5",
      "-BaseUrl", "http://127.0.0.1:9",
      "-ReportRoot", tempRoot,
    ], { encoding: "utf8", timeout: 12000 });
    const elapsedMs = Date.now() - startedAt;
    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.ok(elapsedMs < 10000, `timeout-budget verifier took ${elapsedMs}ms`);
    const report = JSON.parse(readFileSync(previousReportPath, "utf8"));
    assert.equal(report.ok, false);
    assert.equal(report.shortBudgetMode, false);
    assert.ok(report.failures.includes("plugin capability verification budget exhausted before local parity scan"));
    assert.equal(report.sourceSnapshot.fingerprint, "previous-plugin-source");
    assert.equal(report.sourceSnapshot.reusedFromPreviousReport, true);
    assert.match(report.sourceSnapshot.refreshSkippedReason, /budget was exhausted/);
    assert.equal(report.capabilities.nativeCodexWriteback, false);
    assert.equal(report.capabilities.capabilityState, "degraded_timeout_budget");
    assert.equal(report.capabilities.degraded, true);
    assert.equal(report.capabilities.smoke.checked, false);
    assert.equal(report.capabilities.smoke.callableState, "skipped_timeout_budget");
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("plugin capability verifier accepts isolated fake endpoints without connector authorization", async () => {
  const tempRoot = mkdtempSync(resolve(os.tmpdir(), "anticodex-plugin-fake-"));
  const stateRoot = resolve(tempRoot, "state");
  const reportRoot = resolve(tempRoot, "reports");
  const codexHome = resolve(stateRoot, "codex-home-deepseek-app");
  const sharedCodexHome = resolve(stateRoot, "shared-codex-home");
  const agentsSkillsPath = resolve(stateRoot, "agents-skills");
  const connectors = [
    { id: "metadata-demo", name: "Metadata Demo", isEnabled: true, isAccessible: false },
    { id: "metadata-second", name: "Metadata Second", isEnabled: true, isAccessible: false },
  ];
  const tools = [];
  const requests = [];
  const server = http.createServer((req, res) => {
    const { pathname } = new URL(req.url || "/", "http://127.0.0.1");
    requests.push(`${req.method} ${pathname}`);
    const send = (status, payload) => {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(payload));
    };
    if (pathname === "/health") {
      send(200, { ok: true, upstream: "antigravity-desktop", accountReady: false, accountState: "metadata-only", modelCount: 1 });
      return;
    }
    if (pathname === "/backend-api/ps/plugins/installed") {
      send(200, [
        { id: "metadata-plugin", apps: [{ id: "metadata-demo" }] },
        { id: "metadata-second-plugin", apps: [{ id: "metadata-second" }] },
      ]);
      return;
    }
    if (pathname === "/backend-api/plugins/list") {
      send(200, {
        plugins: [
          { summary: { name: "metadata-plugin", skills: ["demo-skill"], mcpServers: ["demo-mcp"] } },
          { summary: { name: "metadata-second-plugin", skills: ["demo-skill"], mcpServers: ["demo-mcp"] } },
        ],
      });
      return;
    }
    if (pathname === "/backend-api/aip/connectors") {
      send(200, { connectors });
      return;
    }
    if (pathname === "/backend-api/wham/apps" && (req.method === "GET" || req.method === "POST")) {
      if (req.method === "POST") {
        req.resume();
        req.on("end", () => send(200, { tools }));
      } else {
        send(200, { tools });
      }
      return;
    }
    send(404, { error: "not_found" });
  });

  try {
    for (const home of [codexHome, sharedCodexHome]) {
      const connectorDir = resolve(home, "cache", "codex_app_directory");
      const toolsDir = resolve(home, "cache", "codex_apps_tools");
      mkdirSync(connectorDir, { recursive: true });
      mkdirSync(toolsDir, { recursive: true });
      mkdirSync(resolve(home, "skills", "metadata-demo"), { recursive: true });
      writeFileSync(resolve(home, "config.toml"), "model = \"metadata-only\"\n", "utf8");
      writeFileSync(resolve(home, "skills", "metadata-demo", "SKILL.md"), "# Metadata Demo\n", "utf8");
      writeFileSync(resolve(connectorDir, "directory.json"), JSON.stringify({ schema_version: 1, connectors }), "utf8");
      writeFileSync(resolve(toolsDir, "tools.json"), JSON.stringify({ schema_version: 2, tools }), "utf8");
    }
    mkdirSync(resolve(agentsSkillsPath, "agent-demo"), { recursive: true });
    writeFileSync(resolve(agentsSkillsPath, "agent-demo", "SKILL.md"), "# Agent Demo\n", "utf8");

    const baseUrl = await listenOnLoopback(server);
    const result = await runChildProcess("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy", "Bypass",
      "-File", resolve(root, "scripts", "test-anticodex-plugin-capabilities.ps1"),
      "-TimeoutSec", "8",
      "-BaseUrl", baseUrl,
      "-StateRoot", stateRoot,
      "-ReportRoot", reportRoot,
      "-CodexHome", codexHome,
      "-SharedCodexHome", sharedCodexHome,
      "-AgentsSkillsPath", agentsSkillsPath,
    ], { timeoutMs: 20000 });
    assert.equal(result.status, 0, [
      result.error?.message,
      result.signal ? `signal=${result.signal}` : "",
      `requests=${requests.join(",")}`,
      result.stdout,
      result.stderr,
    ].filter(Boolean).join("\n"));

    const reportPath = resolve(reportRoot, "latest-plugin-capabilities.json");
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    assert.equal(report.ok, true);
    assert.notEqual(report.shortBudgetMode, true);
    assert.equal(report.capabilities.nativeCodexWriteback, false);
    assert.equal(report.capabilities.capabilityState, "metadata_only_no_accessible_connectors");
    assert.equal(report.capabilities.connectorCount, 2);
    assert.equal(report.capabilities.accessibleConnectorCount, 0);
    assert.equal(report.capabilities.appToolCount, 0);
    assert.equal(report.capabilities.appToolGetCount, 0);
    assert.equal(report.capabilities.smoke.checked, true);
    assert.equal(report.capabilities.smoke.endpointProjectionReadable, true);
    assert.equal(report.capabilities.smoke.callableState, "skipped_no_accessible_connectors");
    assert.equal(report.capabilities.connectorParity.checked, true);
    assert.deepEqual(report.capabilities.connectorParity.missingShared, []);
    assert.deepEqual(report.capabilities.connectorParity.extraLocal, []);
    assert.deepEqual(report.capabilities.connectorParity.changedShared, []);
    assert.equal(report.capabilities.appToolParity.checked, true);
    assert.deepEqual(report.capabilities.appToolParity.missingShared, []);
    assert.deepEqual(report.capabilities.appToolParity.extraLocal, []);
    assert.deepEqual(report.capabilities.appToolParity.changedShared, []);
    assert.equal(report.capabilities.appToolGetPostParity.checked, true);
    assert.equal(report.capabilities.appToolGetPostParity.contentMatches, true);
    assert.deepEqual(report.capabilities.appToolGetPostParity.missingFromGet, []);
    assert.deepEqual(report.capabilities.appToolGetPostParity.extraFromGet, []);
    assert.equal(typeof report.sourceSnapshot.fingerprint, "string");
    assert.ok(report.sourceSnapshot.fileCount > 0);

    const summaryResult = spawnSync(process.execPath, [resolve(root, "scripts", "summarize-anticodex-report.mjs"), reportPath], { encoding: "utf8" });
    assert.equal(summaryResult.status, 0, summaryResult.stderr || summaryResult.stdout);
    const summary = JSON.parse(summaryResult.stdout);
    assert.equal(summary.pluginCapabilityEvidence.smokeChecked, true);
    assert.equal(summary.pluginCapabilityEvidence.endpointProjectionReadable, true);
    assert.equal(summary.pluginCapabilityEvidence.connectorParityClean, true);
    assert.equal(summary.pluginCapabilityEvidence.appToolParityClean, true);
    assert.equal(summary.pluginCapabilityEvidence.appToolGetPostParityClean, true);
  } finally {
    await closeServer(server);
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("plugin capability verifier rejects a single fake app tool for inaccessible connectors", async () => {
  const tempRoot = mkdtempSync(resolve(os.tmpdir(), "anticodex-plugin-fake-negative-"));
  const stateRoot = resolve(tempRoot, "state");
  const reportRoot = resolve(tempRoot, "reports");
  const codexHome = resolve(stateRoot, "codex-home-deepseek-app");
  const sharedCodexHome = resolve(stateRoot, "shared-codex-home");
  const agentsSkillsPath = resolve(stateRoot, "agents-skills");
  const connectors = [
    { id: "metadata-demo", name: "Metadata Demo", isEnabled: true, isAccessible: false },
    { id: "metadata-second", name: "Metadata Second", isEnabled: true, isAccessible: false },
  ];
  const tools = [
    { server_name: "apps", tool_namespace: "demo", tool_name: "unauthorized_tool", connector_id: "metadata-demo" },
  ];
  const requests = [];
  const server = http.createServer((req, res) => {
    const { pathname } = new URL(req.url || "/", "http://127.0.0.1");
    requests.push(`${req.method} ${pathname}`);
    const send = (status, payload) => {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(payload));
    };
    if (pathname === "/health") {
      send(200, { ok: true, upstream: "antigravity-desktop", accountReady: false, accountState: "metadata-only", modelCount: 1 });
      return;
    }
    if (pathname === "/backend-api/ps/plugins/installed") {
      send(200, [
        { id: "metadata-plugin", apps: [{ id: "metadata-demo" }] },
        { id: "metadata-second-plugin", apps: [{ id: "metadata-second" }] },
      ]);
      return;
    }
    if (pathname === "/backend-api/plugins/list") {
      send(200, {
        plugins: [
          { summary: { name: "metadata-plugin", skills: ["demo-skill"], mcpServers: ["demo-mcp"] } },
          { summary: { name: "metadata-second-plugin", skills: ["demo-skill"], mcpServers: ["demo-mcp"] } },
        ],
      });
      return;
    }
    if (pathname === "/backend-api/aip/connectors") {
      send(200, { connectors });
      return;
    }
    if (pathname === "/backend-api/wham/apps" && (req.method === "GET" || req.method === "POST")) {
      if (req.method === "POST") {
        req.resume();
        req.on("end", () => send(200, { tools }));
      } else {
        send(200, { tools });
      }
      return;
    }
    send(404, { error: "not_found" });
  });

  try {
    for (const home of [codexHome, sharedCodexHome]) {
      const connectorDir = resolve(home, "cache", "codex_app_directory");
      const toolsDir = resolve(home, "cache", "codex_apps_tools");
      mkdirSync(connectorDir, { recursive: true });
      mkdirSync(toolsDir, { recursive: true });
      mkdirSync(resolve(home, "skills", "metadata-demo"), { recursive: true });
      writeFileSync(resolve(home, "config.toml"), "model = \"metadata-only\"\n", "utf8");
      writeFileSync(resolve(home, "skills", "metadata-demo", "SKILL.md"), "# Metadata Demo\n", "utf8");
      writeFileSync(resolve(connectorDir, "directory.json"), JSON.stringify({ schema_version: 1, connectors }), "utf8");
      writeFileSync(resolve(toolsDir, "tools.json"), JSON.stringify({ schema_version: 2, tools }), "utf8");
    }
    mkdirSync(resolve(agentsSkillsPath, "agent-demo"), { recursive: true });
    writeFileSync(resolve(agentsSkillsPath, "agent-demo", "SKILL.md"), "# Agent Demo\n", "utf8");

    const baseUrl = await listenOnLoopback(server);
    const result = await runChildProcess("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy", "Bypass",
      "-File", resolve(root, "scripts", "test-anticodex-plugin-capabilities.ps1"),
      "-TimeoutSec", "8",
      "-BaseUrl", baseUrl,
      "-StateRoot", stateRoot,
      "-ReportRoot", reportRoot,
      "-CodexHome", codexHome,
      "-SharedCodexHome", sharedCodexHome,
      "-AgentsSkillsPath", agentsSkillsPath,
    ], { timeoutMs: 20000 });
    assert.equal(result.status, 1, [
      result.error?.message,
      result.signal ? `signal=${result.signal}` : "",
      `requests=${requests.join(",")}`,
      result.stdout,
      result.stderr,
    ].filter(Boolean).join("\n"));

    const reportPath = resolve(reportRoot, "latest-plugin-capabilities.json");
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    assert.equal(report.ok, false);
    assert.equal(report.capabilities.capabilityState, "degraded_verification_failed");
    assert.equal(report.capabilities.accessibleConnectorCount, 0);
    assert.equal(report.capabilities.appToolCount, 1);
    assert.equal(report.capabilities.appToolGetCount, 1);
    assert.equal(report.capabilities.unauthorizedAppToolCount, 1);
    assert.equal(report.capabilities.appToolGetPostParity.checked, true);
    assert.equal(report.capabilities.appToolGetPostParity.contentMatches, true);
    assert.match(report.failures.join("\n"), /app tools exposed without any accessible connector; refusing fake callable capability/);
    assert.match(report.failures.join("\n"), /app tools exposed for connector_id outside accessible connectors; refusing fake callable capability/);
  } finally {
    await closeServer(server);
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("plugin capability verifier rejects GET/POST app-tool mismatch", async () => {
  const tempRoot = mkdtempSync(resolve(os.tmpdir(), "anticodex-plugin-get-post-negative-"));
  const stateRoot = resolve(tempRoot, "state");
  const reportRoot = resolve(tempRoot, "reports");
  const codexHome = resolve(stateRoot, "codex-home-deepseek-app");
  const sharedCodexHome = resolve(stateRoot, "shared-codex-home");
  const agentsSkillsPath = resolve(stateRoot, "agents-skills");
  const connectors = [
    { id: "metadata-demo", name: "Metadata Demo", isEnabled: true, isAccessible: false },
    { id: "metadata-second", name: "Metadata Second", isEnabled: true, isAccessible: false },
  ];
  const postTools = [
    { server_name: "apps", tool_namespace: "demo", tool_name: "post_only_tool", connector_id: "metadata-demo" },
  ];
  const getTools = [];
  const requests = [];
  const server = http.createServer((req, res) => {
    const { pathname } = new URL(req.url || "/", "http://127.0.0.1");
    requests.push(`${req.method} ${pathname}`);
    const send = (status, payload) => {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(payload));
    };
    if (pathname === "/health") {
      send(200, { ok: true, upstream: "antigravity-desktop", accountReady: false, accountState: "metadata-only", modelCount: 1 });
      return;
    }
    if (pathname === "/backend-api/ps/plugins/installed") {
      send(200, [
        { id: "metadata-plugin", apps: [{ id: "metadata-demo" }] },
        { id: "metadata-second-plugin", apps: [{ id: "metadata-second" }] },
      ]);
      return;
    }
    if (pathname === "/backend-api/plugins/list") {
      send(200, {
        plugins: [
          { summary: { name: "metadata-plugin", skills: ["demo-skill"], mcpServers: ["demo-mcp"] } },
          { summary: { name: "metadata-second-plugin", skills: ["demo-skill"], mcpServers: ["demo-mcp"] } },
        ],
      });
      return;
    }
    if (pathname === "/backend-api/aip/connectors") {
      send(200, { connectors });
      return;
    }
    if (pathname === "/backend-api/wham/apps" && (req.method === "GET" || req.method === "POST")) {
      if (req.method === "POST") {
        req.resume();
        req.on("end", () => send(200, { tools: postTools }));
      } else {
        send(200, { tools: getTools });
      }
      return;
    }
    send(404, { error: "not_found" });
  });

  try {
    for (const home of [codexHome, sharedCodexHome]) {
      const connectorDir = resolve(home, "cache", "codex_app_directory");
      const toolsDir = resolve(home, "cache", "codex_apps_tools");
      mkdirSync(connectorDir, { recursive: true });
      mkdirSync(toolsDir, { recursive: true });
      mkdirSync(resolve(home, "skills", "metadata-demo"), { recursive: true });
      writeFileSync(resolve(home, "config.toml"), "model = \"metadata-only\"\n", "utf8");
      writeFileSync(resolve(home, "skills", "metadata-demo", "SKILL.md"), "# Metadata Demo\n", "utf8");
      writeFileSync(resolve(connectorDir, "directory.json"), JSON.stringify({ schema_version: 1, connectors }), "utf8");
      writeFileSync(resolve(toolsDir, "tools.json"), JSON.stringify({ schema_version: 2, tools: postTools }), "utf8");
    }
    mkdirSync(resolve(agentsSkillsPath, "agent-demo"), { recursive: true });
    writeFileSync(resolve(agentsSkillsPath, "agent-demo", "SKILL.md"), "# Agent Demo\n", "utf8");

    const baseUrl = await listenOnLoopback(server);
    const result = await runChildProcess("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy", "Bypass",
      "-File", resolve(root, "scripts", "test-anticodex-plugin-capabilities.ps1"),
      "-TimeoutSec", "8",
      "-BaseUrl", baseUrl,
      "-StateRoot", stateRoot,
      "-ReportRoot", reportRoot,
      "-CodexHome", codexHome,
      "-SharedCodexHome", sharedCodexHome,
      "-AgentsSkillsPath", agentsSkillsPath,
    ], { timeoutMs: 20000 });
    assert.equal(result.status, 1, [
      result.error?.message,
      result.signal ? `signal=${result.signal}` : "",
      `requests=${requests.join(",")}`,
      result.stdout,
      result.stderr,
    ].filter(Boolean).join("\n"));

    const reportPath = resolve(reportRoot, "latest-plugin-capabilities.json");
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    assert.equal(report.ok, false);
    assert.equal(report.capabilities.accessibleConnectorCount, 0);
    assert.equal(report.capabilities.appToolCount, 1);
    assert.equal(report.capabilities.appToolGetCount, 0);
    assert.equal(report.capabilities.appToolGetPostParity.checked, true);
    assert.equal(report.capabilities.appToolGetPostParity.contentMatches, false);
    assert.deepEqual(report.capabilities.appToolGetPostParity.missingFromGet, ["metadata-demo|apps|demo|post_only_tool"]);
    assert.deepEqual(report.capabilities.appToolGetPostParity.extraFromGet, []);
    assert.match(report.failures.join("\n"), /GET \/backend-api\/wham\/apps does not match POST tool projection/);
  } finally {
    await closeServer(server);
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("Anti-Codex ships a script-level local connector and app-tool verifier", () => {
  const localConnectors = readFileSync(resolve(root, "scripts", "test-anticodex-local-connectors.mjs"), "utf8");

  assert.match(localConnectors, /reportName:\s*"local-connectors"/);
  assert.match(localConnectors, /usedRealTraffic:\s*false/);
  assert.match(localConnectors, /behaviorCovered:\s*true/);
  assert.match(localConnectors, /coverageKind:\s*"local-fake-provider"/);
  assert.match(localConnectors, /assertLocalConnectorProjection/);
  assert.match(localConnectors, /toolNames\(whamPost\)/);
  assert.match(localConnectors, /toolNames\(whamGet\)/);
  assert.match(localConnectors, /allowlisted_tool/);
  assert.match(localConnectors, /hidden_tool/);
  assert.match(localConnectors, /orphan_tool/);
  assert.match(localConnectors, /local connector\/app-tool endpoints must not make provider or OAuth upstream requests/);
  assert.match(localConnectors, /linkEndpointsUnsupported/);
  assert.match(localConnectors, /upstreamRequestsDuringLocalEndpoints/);
  assert.doesNotMatch(localConnectors, /auth\/login/);
});

test("Anti-Codex ships a translator-only recovery verification script", () => {
  const recovery = readFileSync(resolve(root, "scripts", "test-anticodex-translator-recovery.ps1"), "utf8");

  assert.match(recovery, /\$BaseUrl/);
  assert.match(recovery, /\$RuntimeRoot/);
  assert.match(recovery, /\$TimeoutSec/);
  assert.match(recovery, /start-deepcodex\.ps1/);
  assert.match(recovery, /\[void\]\$launcherProc\.Handle/);
  assert.match(recovery, /-TranslatorOnly/);
  assert.match(recovery, /LocalApplicationData/);
  assert.match(recovery, /Get-Command "powershell\.exe"/);
  assert.match(recovery, /TRANSLATOR_UPSTREAM_MODE\s*=\s*["']antigravity["']/i);
  assert.match(recovery, /ANTICODEX_ANTIGRAVITY_TRANSPORT\s*=\s*["']cli["']/i);
  assert.match(recovery, /ANTICODEX_NATIVE_TOOL_BRIDGE\s*=\s*["']0["']/i);
  assert.match(recovery, /ANTICODEX_ANTIGRAVITY_CLI_PROFILE_ROOT/);
  assert.doesNotMatch(recovery, /ANTICODEX_NATIVE_TOOL_BRIDGE\s*=\s*["']1["']/i);
  assert.match(recovery, /CODEX_HOME_DIR\s*=\s*\$codexHome/);
  assert.match(recovery, /\$health\.modelCount/);
  assert.match(recovery, /antigravity-desktop/);
  assert.match(recovery, /\/health/);
  assert.match(recovery, /\/backend-api\/ps\/plugins\/installed/);
  assert.match(recovery, /\/backend-api\/wham\/apps/);
  assert.match(recovery, /appToolCount/);
  assert.match(recovery, /Get-FileSnapshot/);
  assert.match(recovery, /originalCodexConfigUnchanged/);
  assert.match(recovery, /translator-only recovery changed original Codex config\.toml/);
  assert.match(recovery, /Proxy\s*=\s*\$null/);
  assert.match(recovery, /ConvertTo-Json/);

  assert.doesNotMatch(
    recovery,
    /\[Math\]::Max\(60000/,
    "translator-only recovery verifier must not use [Math]::Max(60000 as launcher timeout; verifier must finish under 30 seconds",
  );
  assert.match(
    recovery,
    /\b(?:25000|30000)\b/,
    "translator-only recovery verifier must have a hard deadline 鈮?25000ms or equivalent 30-second boundary (verifier must finish under 30 seconds)",
  );
  assert.match(
    recovery,
    /launcherTimeoutMs\s*=\s*\[Math\]::Min\(12000/,
    "translator-only recovery launcher wait must be capped near 12 seconds so the whole verifier stays under 30 seconds",
  );
  assert.doesNotMatch(recovery, /\.WaitForExit\(\$launcherTimeoutMs\)/);
  assert.match(recovery, /\$launcherProc\.HasExited/);
  assert.match(recovery, /RedirectStandardOutput/);
  assert.match(recovery, /RedirectStandardError/);
  assert.match(recovery, /phaseTimings/);
  assert.match(recovery, /launcherElapsedMs/);
  assert.match(recovery, /totalElapsedMs/);

  assert.doesNotMatch(recovery, /Stop-Process/);
  assert.doesNotMatch(recovery, /Codex\.exe/);
  assert.doesNotMatch(recovery, /Anti-Codex\.exe/);
  assert.doesNotMatch(recovery, /chatgpt\.com/);
  assert.doesNotMatch(recovery, /auth\/login/);
});

test("Anti-Codex ships a cold relaunch verification script", () => {
  const relaunch = readFileSync(resolve(root, "scripts", "test-anticodex-cold-relaunch.ps1"), "utf8");

  assert.match(relaunch, /start-anticodex\.ps1/);
  assert.match(relaunch, /\[switch\]\$ConfirmRelaunch/);
  assert.match(relaunch, /requires -ConfirmRelaunch because it stops and restarts Anti-Codex/);
  assert.match(relaunch, /exit 2/);
  assert.match(relaunch, /codex-patched-app/);
  assert.match(relaunch, /Get-AntiCodexHostProcesses/);
  assert.match(relaunch, /Get-AntiCodexMainProcesses/);
  assert.match(relaunch, /Anti-Codex\.exe/);
  assert.match(relaunch, /Get-AntiCodexTranslatorProcesses/);
  assert.match(relaunch, /Get-AntiCodexLauncherProcesses/);
  assert.match(relaunch, /Get-OriginalCodexMainProcesses/);
  assert.match(relaunch, /originalCodexStopTargetIntersection/);
  assert.match(relaunch, /original Codex process was selected as an Anti-Codex stop target/);
  assert.match(relaunch, /pidSetUnchanged/);
  assert.match(relaunch, /originalCodex/);
  assert.match(relaunch, /unchanged/);
  assert.match(relaunch, /beforePids/);
  assert.match(relaunch, /afterPids/);
  assert.match(relaunch, /\/health/);
  assert.match(relaunch, /antigravity-desktop/);
  assert.match(relaunch, /Resolve-AntiCodexMode/);
  assert.match(relaunch, /Test-AntiCodexRelaunchHealthReady/);
  assert.match(relaunch, /upstreamProfile\.model/);
  assert.match(relaunch, /providerReady/);
  assert.match(relaunch, /modelCount/);
  assert.match(relaunch, /-Proxy\s+\$null/);
  assert.match(relaunch, /TimeoutSec 2/);
  assert.match(relaunch, /WindowStyle Hidden/);
  assert.match(relaunch, /launcherOutPath/);
  assert.match(relaunch, /Read-TextFileTail/);
  assert.match(relaunch, /RedirectStandardOutput/);
  assert.match(relaunch, /RedirectStandardError/);
  assert.match(relaunch, /PassThru/);
  assert.match(relaunch, /launcherProc\.Refresh\(\)/);
  assert.match(relaunch, /launcher = \[pscustomobject\]/);
  assert.match(relaunch, /stdoutTail = \$launcherStdoutTail/);
  assert.match(relaunch, /stderrTail = \$launcherStderrTail/);
  assert.match(relaunch, /TimeoutSec = 18/);
  assert.match(relaunch, /StopTimeoutSec = 5/);
  assert.match(relaunch, /HealthPollTimeoutSec/);
  assert.match(relaunch, /New-Stage/);
  assert.match(relaunch, /stages = \$stages\.ToArray\(\)/);
  assert.doesNotMatch(relaunch, /TimeoutSec = 90/);
  assert.match(relaunch, /stop-existing-processes/);
  assert.match(relaunch, /wait-health-ready/);
  assert.match(relaunch, /ReportRoot/);
  assert.match(relaunch, /New-ReportPaths "cold-relaunch"/);
  assert.match(relaunch, /latest-\$Name\.json/);
  assert.match(relaunch, /Write-AntiCodexJsonReport/);
  assert.match(relaunch, /UTF8Encoding\]::new\(\$false\)/);
  assert.match(relaunch, /reportName = "cold-relaunch"/);
  assert.match(relaunch, /report = \[pscustomobject\]/);
  assert.match(relaunch, /latest = \$reportPaths\.latest/);
  assert.match(relaunch, /history = \$reportPaths\.history/);

  assert.doesNotMatch(relaunch, /Antigravity\.exe/);
  assert.doesNotMatch(relaunch, /chatgpt\.com/);
  assert.doesNotMatch(relaunch, /auth\/login/);
});

test("cold relaunch verifier refuses to restart without explicit confirmation", () => {
  const script = resolve(root, "scripts", "test-anticodex-cold-relaunch.ps1");
  const result = spawnSync("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    script,
    "-BaseUrl",
    "http://127.0.0.1:1",
  ], { encoding: "utf8" });

  assert.notEqual(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.reportName, "cold-relaunch");
  assert.equal(payload.ok, false);
  assert.equal(payload.skipped, true);
  assert.equal(payload.requiresConfirmation, true);
  assert.match(payload.reason, /requires -ConfirmRelaunch/);
});

test("Anti-Codex ships a read-only installed overall verification script", () => {
  const overall = readFileSync(resolve(root, "scripts", "test-anticodex-installed-overall.ps1"), "utf8");

  assert.match(overall, /\/health/);
  assert.match(overall, /\/models/);
  assert.match(overall, /\$healthMode = "unknown"/);
  assert.match(overall, /\$healthMode -eq "third-party"/);
  assert.match(overall, /third-party upstream missing protocol/);
  assert.match(overall, /third-party upstream missing model/);
  assert.match(overall, /Antigravity health missing modelTextTransport/);
  assert.match(overall, /expected cli/);
  assert.match(overall, /Antigravity health missing modelDiscoverySource/);
  assert.match(overall, /Antigravity model discovery source is '\$healthModelDiscoverySource', expected an allowed catalog source/);
  assert.match(overall, /antigravity-cli-catalog/);
  assert.match(overall, /Antigravity health missing antigravityCoworkerDefault/);
  assert.match(overall, /Antigravity coworker must not be the default tool execution path/);
  assert.match(overall, /modelTextTransport = \$healthModelTextTransport/);
  assert.match(overall, /modelDiscoverySource = \$healthModelDiscoverySource/);
  assert.match(overall, /antigravityCoworkerDefault = \$healthAntigravityCoworkerDefault/);
  assert.match(overall, /unknown upstream mode/);
  assert.match(overall, /mode = \$healthMode/);
  assert.doesNotMatch(overall, /third-party mode skips Antigravity UI catalog verification/);
  assert.match(overall, /third-party mode keeps UI\/Manager verification enabled/);
  assert.match(overall, /third-party mode uses provider-native-or-compat bridge/);
  assert.match(overall, /provider-native-or-compat/);
  assert.match(overall, /upstream-provider/);
  assert.doesNotMatch(overall, /third-party mode skips Antigravity model routing verification/);
  assert.match(overall, /No-traffic model routing verification/);
  assert.match(overall, /third-party mode skips Antigravity thinking-budget verification/);
  assert.doesNotMatch(overall, /third-party mode skips Antigravity cancellation readiness verification/);
  assert.match(overall, /third-party mode verifies provider streaming cancellation/);
  assert.match(overall, /"-Model", \$\(if \(\$healthModel\) \{ \$healthModel \} else \{ "" \}\)/);
  assert.match(overall, /third-party mode skips Antigravity account\/proxy verification/);
  assert.doesNotMatch(overall, /third-party mode skips Antigravity stability soak/);
  assert.match(overall, /third-party mode verifies provider stability soak/);
  assert.doesNotMatch(overall, /third-party mode skips Antigravity cold relaunch verification/);
  assert.match(overall, /third-party mode verifies provider cold relaunch/);
  assert.match(overall, /function Remove-OldReports/);
  assert.match(overall, /Select-Object -Skip \$Keep/);
  assert.match(overall, /Test-InstalledBranding/);
  assert.match(overall, /Test-ExternalBranding/);
  assert.match(overall, /Read-AsarHeader/);
  assert.match(overall, /setAppUserModelId\(`AntiCodex`\)/);
  assert.match(overall, /app\.name=`Anti-Codex`/);
  assert.match(overall, /setToolTip\\\(\[\^\)\]\*\\\.app\\\.getName/);
  assert.match(overall, /installed branding verification failed/);
  assert.match(overall, /external Anti-Codex branding verification failed/);
  assert.match(overall, /FileDescription/);
  assert.match(overall, /ProductName/);
  assert.match(overall, /OriginalFilename/);
  assert.match(overall, /test-anticodex-ui-state\.ps1/);
  assert.match(overall, /UI state verification/);
  assert.match(overall, /\$uiProbeTimeoutSec = \[Math\]::Max\(1, \[Math\]::Min\(\$TimeoutSec, \[Math\]::Max\(1, \$SubcheckTimeoutSec - 10\)\)\)/);
  assert.match(overall, /\$uiStateArgs = @\("-BaseUrl", \$BaseUrl, "-TimeoutSec", "\$uiProbeTimeoutSec"\)/);
  assert.match(overall, /if \(\$Fast\) \{ \$uiStateArgs \+= @\("-Fast"\) \}/);
  assert.match(overall, /SubcheckTimeoutSec = 60/);
  assert.match(overall, /function Get-InstalledOverallDiagnosticsSnapshot/);
  assert.match(overall, /\$script:InstalledOverallDiagnosticsSnapshot/);
  assert.match(overall, /function Test-FastBudgetAvailable/);
  assert.match(overall, /function New-FastBudgetSkippedCheck/);
  assert.match(overall, /function Get-FreshMcpSkillsReportCheck/);
  assert.match(overall, /fresh-mcp-skills-report/);
  assert.match(overall, /function Get-FreshPluginCapabilitiesReportCheck/);
  assert.match(overall, /fresh-plugin-capabilities-report/);
  assert.match(overall, /reusedLatestReport = \$true/);
  assert.match(overall, /\$report\.shortBudgetMode -ne \$true/);
  assert.match(overall, /\[string\]\$capabilities\.capabilityState -ne "degraded_short_budget"/);
  assert.match(overall, /\$capabilities\.smoke\.checked -eq \$true/);
  assert.match(overall, /\$expectedWorkerMcpServers = @\(/);
  assert.match(overall, /"mimo-claude-coworker"/);
  assert.match(overall, /"mimocode-worker"/);
  assert.match(overall, /"deveco-code-worker"/);
  assert.match(overall, /"opencode-worker"/);
  assert.match(overall, /"kilo-worker"/);
  assert.match(overall, /\$missingWorkerMcpRealList\.Count -eq 0/);
  assert.doesNotMatch(overall, /realListPassed -ge 2/);
  assert.match(overall, /\$report\.skills\.fingerprintSkipped -ne \$true/);
  assert.match(overall, /connectorParityClean = \$true/);
  assert.match(overall, /appToolParityClean = \$true/);
  assert.match(overall, /appToolGetPostParityClean = \$true/);
  assert.match(overall, /\$appToolGetPostParity\.contentMatches -eq \$true/);
  assert.match(overall, /\$appToolGetPostParity\.checked -eq \$true/);
  assert.match(overall, /\$missingAppToolsFromGet\.Count -eq 0/);
  assert.match(overall, /\$extraAppToolsFromGet\.Count -eq 0/);
  assert.match(overall, /\[int\]\$capabilities\.unauthorizedAppToolCount -eq 0/);
  assert.match(overall, /\[int\]\$capabilities\.unattributedAppToolCount -eq 0/);
  assert.match(overall, /\$freshMcpSkillsCheck = if \(\$Fast -or \$NoTraffic\) \{ Get-FreshMcpSkillsReportCheck \}/);
  assert.match(overall, /\$freshPluginCapabilitiesCheck = if \(\$Fast -or \$NoTraffic\) \{ Get-FreshPluginCapabilitiesReportCheck \}/);
  assert.match(overall, /function Wait-AntiCodexSubcheckProcess/);
  assert.match(overall, /\$Process\.HasExited/);
  assert.match(overall, /\[void\]\$process\.Handle/);
  assert.doesNotMatch(overall, /WaitForExit\(\[Math\]::Max\(1, \$SubcheckTimeoutSec\) \* 1000\)/);
  assert.match(overall, /timed out after \$SubcheckTimeoutSec seconds/);
  assert.doesNotMatch(overall, /Start-Process[\s\S]{0,260}-Wait[\s\S]{0,260}-RedirectStandardOutput/);
  assert.match(overall, /function Invoke-NodeJsonScript/);
  assert.match(overall, /function Read-AntiCodexTempTextWithRetry/);
  assert.match(overall, /FileShare\]::ReadWrite/);
  assert.match(overall, /Read-AntiCodexTempTextWithRetry \$stdoutPath/);
  assert.match(overall, /Read-AntiCodexTempTextWithRetry \$stderrPath/);
  const nodeJsonBody = overall.slice(
    overall.indexOf("function Invoke-NodeJsonScript"),
    overall.indexOf("function New-ReportPaths"),
  );
  assert.match(nodeJsonBody, /Start-Process -FilePath \$node/);
  assert.match(nodeJsonBody, /Wait-AntiCodexSubcheckProcess/);
  assert.doesNotMatch(nodeJsonBody, /WaitForExit\(\[Math\]::Max\(1, \$SubcheckTimeoutSec\) \* 1000\)/);
  assert.match(nodeJsonBody, /Node script timed out after \$ProcessTimeoutSec seconds/);
  assert.doesNotMatch(nodeJsonBody, /\$output = @\(& \$node/);
  assert.match(overall, /test-anticodex-manager-button\.mjs/);
  assert.match(overall, /combined overall skips the long MCP\/Skill Manager click/);
  assert.match(overall, /test-anticodex-manager-real-buttons\.ps1/);
  assert.match(overall, /combined overall skips the long plugin\/application Manager click/);
  assert.match(overall, /Manager safe button smoke verification/);
  assert.match(overall, /combined overall skips background Manager safe-action batch/);
  assert.match(overall, /combined overall skips report button real click/);
  assert.match(overall, /combined overall skips diagnostics bundle real click/);
  assert.match(overall, /function Clear-ManagerButtonVerifierLock/);
  assert.match(overall, /function Get-ManagerButtonVerifierLockStatus/);
  assert.match(overall, /function New-ManagerVerifierBusyCheck/);
  assert.match(overall, /anticodex-manager-button\.lock/);
  assert.match(overall, /external-owner-alive/);
  assert.match(overall, /Manager\/UI verifier lock is already held; rerun installed overall serially/);
  assert.match(overall, /manager-verifier-lock-busy/);
  assert.ok(
    overall.indexOf("$managerVerifierLockStatus = Get-ManagerButtonVerifierLockStatus") < overall.indexOf('Invoke-JsonScript "UI state verification"'),
    "installed overall must check the Manager/UI verifier lock before launching UI-state",
  );
  assert.match(overall, /Node script timed out after \$ProcessTimeoutSec seconds/);
  assert.doesNotMatch(overall, /"--action", "mcpSkills", "--timeout-ms", "\$managerButtonTimeoutMs", "--compact", "1"\) \$managerButtonProcessTimeoutSec/);
  assert.doesNotMatch(overall, /--action", "pluginCapabilities"/);
  assert.doesNotMatch(overall, /"--action", "pluginCapabilities", "--timeout-ms", "\$managerButtonTimeoutMs", "--compact", "1"\) \$managerButtonProcessTimeoutSec/);
  assert.match(overall, /--verification-mode", "ui-only"/);
  assert.doesNotMatch(overall, /--actions", "mcpSkills,pluginCapabilities"/);
  assert.match(overall, /managerButtonSafeActions/);
  assert.match(overall, /managerButtonReportActions/);
  assert.match(overall, /managerButtonDiagnosticsBundle/);
  assert.match(overall, /fast mode skips real Manager safe button batch/);
  assert.match(overall, /fast mode skips real Manager report button batch/);
  assert.match(overall, /fast mode skips the slow Manager diagnostics bundle click/);
  assert.match(overall, /--compact", "1"/);
  assert.doesNotMatch(overall, /fast mode skips Manager MCP\/Skill button smoke/);
  assert.doesNotMatch(overall, /fast mode skips Manager plugin\/application button smoke/);
  assert.match(overall, /fast mode covers plugin\/application button state through UI verification/);
  assert.match(overall, /test-anticodex-manager-action\.ps1/);
  assert.match(overall, /combined overall skips direct Manager action security probe/);
  assert.match(overall, /\$checks\.managerAction = if \(\$Fast -or \$SkipManagerActionProbe\)/);
  assert.match(overall, /\$checks\.uiIdleStability = if \(\$Fast -or \$SkipManagerActionProbe\)/);
  assert.match(overall, /"\$\(\[Math\]::Min\(\[Math\]::Max\(\$TimeoutSec, 60\), \[Math\]::Max\(1, \$SubcheckTimeoutSec - 10\)\)\)"/);
  assert.match(overall, /SkipManagerActionProbe skips direct Manager action security probe/);
  assert.match(overall, /standalone uiIdleStability release gate remains authoritative/);
  assert.match(overall, /SkipUiStateProbe avoids reopening the embedded Manager from inside a Manager action/);
  assert.match(overall, /SkipUiStateProbe skips recursive Manager button smoke from inside the embedded Manager/);
  assert.match(overall, /function Remove-OldReportHistories/);
  assert.match(overall, /Group-Object name/);
  assert.match(overall, /Select-Object -Skip \$Keep/);
  assert.match(overall, /test-anticodex-diagnostics\.ps1/);
  assert.match(overall, /Diagnostics verification/);
  assert.match(overall, /\$checks\.diagnostics = if \(\$Fast\)/);
  assert.match(overall, /sourcePreflightPublicDocumentation/);
  assert.match(overall, /sourcePreflight\.publicDocumentationOk/);
  assert.match(overall, /sourcePreflight\.publicDocumentationClientCopySyncContractOk/);
  assert.match(overall, /publicDocumentationOk and publicDocumentationClientCopySyncContractOk must be green/);
  assert.match(overall, /source preflight public documentation status is missing or not green in diagnostics/);
  assert.match(overall, /source preflight publicDocumentationClientCopySyncContractOk is missing or not green in diagnostics/);
  assert.match(overall, /sourcePreflightAntigravityCliProfilePrepare/);
  assert.match(overall, /sourcePreflight\.antigravityCliProfilePrepareOk/);
  assert.match(overall, /antigravityCliProfilePrepareContract/);
  assert.match(overall, /profilePrepareContract\.usedRealTraffic -eq \$false/);
  assert.match(overall, /profilePrepareContract\.loginVerified -eq \$false/);
  assert.match(overall, /profilePrepareContract\.separateAccountVerified -eq \$false/);
  assert.match(overall, /profilePrepareContract\.coverageKind -eq "profile-prepared-no-traffic"/);
  assert.match(overall, /profilePrepareContract\.accountIsolationCaveat/);
  assert.match(overall, /source preflight antigravity CLI profile prepare no-traffic contract is missing or invalid in diagnostics/);
  assert.match(overall, /must be green with a no-traffic false-verification contract/);
  assert.match(overall, /logDbGuardDiagnostics/);
  assert.match(overall, /diagnostics\.logDbGuard/);
  assert.match(overall, /installed overall log database guard is not protected/);
  assert.match(overall, /installed overall log database guard trigger is missing/);
  assert.match(overall, /test-anticodex-tool-bridge-mode\.ps1/);
  assert.match(overall, /Tool bridge mode verification/);
  assert.match(overall, /test-anticodex-runtime-config\.ps1/);
  assert.match(overall, /Runtime config verification/);
  assert.match(overall, /\$checks\.runtimeConfig = if \(\$Fast\)/);
  assert.match(overall, /test-anticodex-websocket-fallback\.ps1/);
  assert.match(overall, /Websocket fallback verification/);
  assert.match(overall, /\$checks\.websocketFallback = if \(\$Fast\)/);
  assert.match(overall, /test-anticodex-third-party-provider\.mjs/);
  assert.match(overall, /Third-party provider local end-to-end verification/);
  assert.match(overall, /function Get-FreshThirdPartyProviderReportCheck/);
  assert.match(overall, /latest-third-party-provider\.json/);
  assert.match(overall, /fresh-third-party-provider-report/);
  assert.match(overall, /\$freshThirdPartyProviderCheck = if \(\$NoTraffic\) \{ Get-FreshThirdPartyProviderReportCheck \}/);
  assert.match(overall, /\$thirdPartyProviderTimeoutMs = 90000/);
  assert.match(overall, /\$thirdPartyProviderProcessTimeoutSec = \[int\]\[Math\]::Ceiling\(\$thirdPartyProviderTimeoutMs \/ 1000\) \+ 15/);
  assert.match(overall, /"--timeout-ms", "\$thirdPartyProviderTimeoutMs"[\s\S]{0,120}\) \$thirdPartyProviderProcessTimeoutSec/);
  assert.match(overall, /\$checks\.thirdPartyProvider = if \(\$Fast\)/);
  assert.match(overall, /fast mode skips local third-party provider end-to-end verification/);
  assert.match(overall, /New-FastBudgetSkippedCheck "missing response history verification"/);
  assert.match(overall, /test-anticodex-local-connectors\.mjs/);
  assert.match(overall, /Local connector\/app-tool allowlist verification/);
  assert.match(overall, /\$checks\.localConnectors = if \(\$Fast\)/);
  assert.match(overall, /fast mode skips local connector\/app-tool allowlist verification/);
  assert.match(overall, /latest-local-connectors\.json/);
  assert.match(overall, /"--source-root", \$runtimeRootFull/);
  assert.match(overall, /"--runtime-root", \$RuntimeRoot/);
  assert.match(overall, /"--report-root", \$ReportRoot/);
  assert.match(overall, /test-anticodex-codex-responses\.ps1/);
  assert.match(overall, /Codex internal Responses stream verification/);
  assert.match(overall, /test-anticodex-model-switch-history\.ps1/);
  assert.match(overall, /Model switch history verification/);
  assert.match(overall, /test-anticodex-ui-idle-stability\.ps1/);
  assert.match(overall, /-SkipManagerActionProbe/);
  assert.match(overall, /NoTraffic/);
  assert.match(overall, /EnsureRunning/);
  assert.match(overall, /function Start-AntiCodexIfNeeded/);
  assert.match(overall, /start-anticodex\.ps1/);
  assert.match(overall, /"-SkipUpdateCheck"/);
  assert.match(overall, /Wait-Until -TimeoutSeconds 60/);
  assert.match(overall, /Anti-Codex did not become healthy after launch request/);
  assert.match(overall, /Anti-Codex is not running; rerun with -EnsureRunning or start Anti-Codex first/);
  assert.match(overall, /noTraffic/);
  assert.match(overall, /accountTrafficReady/);
  assert.match(overall, /accountTrafficState/);
  assert.match(overall, /accountTrafficDiagnosis/);
  assert.match(overall, /modelRoutingNoTraffic/);
  assert.match(overall, /No-traffic model routing verification/);
  assert.doesNotMatch(overall, /\$checks\.modelRoutingNoTraffic = if \(\$healthMode -eq "third-party"\)/);
  assert.match(overall, /\$checks\.modelThinking = if \(\$healthMode -eq "third-party"\)/);
  assert.match(overall, /elseif \(\$Fast\)/);
  assert.match(overall, /fast mode uses UI model labels and native thinking budgets/);
  assert.match(overall, /-SkipRequests/);
  assert.match(overall, /if \(-not \$NoTraffic\)/);
  assert.match(overall, /Get-AntiCodexHostProcesses/);
  assert.match(overall, /Get-AntiCodexMainProcesses/);
  assert.match(overall, /hostProcessCount/);
  assert.match(overall, /mainNames/);
  assert.match(overall, /hostProcessNames/);
  assert.match(overall, /Anti-Codex\.exe/);
  assert.match(overall, /Get-AntiCodexTranslatorProcesses/);
  assert.match(overall, /Get-OriginalCodexMainProcesses/);
  assert.match(overall, /\$checks\.independence = if \(\$Fast\)/);
  assert.match(overall, /test-anticodex-mcp-skills\.ps1/);
  assert.match(overall, /\$freshMcpSkillsCheck = if \(\$Fast -or \$NoTraffic\) \{ Get-FreshMcpSkillsReportCheck \}/);
  assert.match(overall, /New-FastBudgetSkippedCheck "MCP\/skills verification"/);
  assert.match(overall, /test-anticodex-plugin-capabilities\.ps1/);
  assert.match(overall, /\$freshPluginCapabilitiesCheck = if \(\$Fast -or \$NoTraffic\) \{ Get-FreshPluginCapabilitiesReportCheck \}/);
  assert.match(overall, /New-FastBudgetSkippedCheck "plugin capability verification"/);
  assert.match(overall, /New-SkippedCheck/);
  assert.match(overall, /behaviorCovered = \$false/);
  assert.match(overall, /coverageKind = "skipped"/);
  assert.match(overall, /covered by Manager MCP\/Skill button smoke/);
  assert.match(overall, /covered by Manager plugin\/application button smoke/);
  assert.match(overall, /managerButtonSourcePreflight/);
  assert.match(overall, /Manager source preflight button verification/);
  assert.match(overall, /--action", "sourcePreflight"/);
  assert.match(overall, /test-anticodex-tool-bridge-mode\.ps1/);
  assert.match(overall, /Tool bridge mode verification/);
  assert.match(overall, /fast mode skips direct Manager action security probe/);
  assert.match(overall, /standalone verifier remains the authority for token\/source-header checks/);
  assert.match(overall, /test-anticodex-sync-readiness\.ps1/);
  assert.match(overall, /Sync readiness verification/);
  assert.match(overall, /function Test-SyncReadinessHostSyncOnly/);
  assert.match(overall, /source_codex_changed/);
  assert.match(overall, /hostSyncRequired/);
  assert.match(overall, /overallBlocking/);
  assert.match(overall, /releaseBlocking/);
  assert.match(overall, /host_sync_required_not_runtime_unusable/);
  assert.match(overall, /Remove-Failure "Sync readiness verification failed with exit code 1"/);
  assert.match(overall, /Remove-Failure "Sync readiness verification reported ok=false"/);
  assert.match(overall, /test-anticodex-mcp-tool-loop\.ps1/);
  assert.match(overall, /MCP tool loop verification/);
  assert.match(overall, /test-anticodex-custom-tool-loop\.ps1/);
  assert.match(overall, /Custom\/freeform tool loop verification/);
  assert.match(overall, /test-anticodex-account-proxy-readiness\.ps1/);
  assert.match(overall, /\$reportName = if \(\$Fast\) \{ "installed-overall-fast" \} else \{ "installed-overall" \}/);
  assert.match(overall, /New-ReportPaths \$reportName/);
  assert.match(overall, /reportName/);
  assert.match(overall, /Save-JsonReport/);
  assert.match(overall, /latest-\$Name\.json/);
  assert.match(overall, /SkipAccountProxyProbe/);
  assert.match(overall, /FastMaxElapsedMs = 90000/);
  assert.match(overall, /fast installed overall exceeded/);
  assert.match(overall, /fastMaxElapsedMs/);
  assert.match(overall, /function Test-ReportEncoding/);
  assert.match(overall, /latest-mcp-tool-loop\.json/);
  assert.match(overall, /latest-stability-soak\.json/);
  assert.match(overall, /latest-codex-responses\.json/);
  assert.match(overall, /latest-native-tool-loop\.json/);
  assert.match(overall, /latest-manager-real-buttons\.json/);
  assert.match(overall, /\$checks\.reportEncoding = Test-ReportEncoding/);
  assert.match(overall, /report encoding verification failed/);
  assert.match(overall, /function Test-ReportIntegrity/);
  assert.match(overall, /\.sha256/);
  assert.match(overall, /missing SHA256 sidecar/);
  assert.match(overall, /SHA256 sidecar mismatch/);
  assert.match(overall, /function Test-InstalledGuardWording/);
  assert.match(overall, /\$checks\.guardWording = Test-InstalledGuardWording/);
  assert.match(overall, /guard wording leaks DeepCodex/);
  assert.match(overall, /guard wording still contains old continue phrasing/);
  assert.match(overall, /friendlyFakeExecution = \[string\]::Concat/);
  assert.match(overall, /0x6CA1,\s*0x6709,\s*0x771F,\s*0x7684,\s*0x8BFB,\s*0x6587,\s*0x4EF6/);
  assert.match(overall, /test-anticodex-stability-soak\.ps1/);
  assert.match(overall, /"-ReportRoot", \$ReportRoot/);
  assert.match(overall, /test-anticodex-cold-relaunch\.ps1/);
  assert.match(overall, /HealthPollTimeoutSec/);
  assert.match(overall, /"-ConfirmRelaunch"/);
  assert.doesNotMatch(overall, /"-TimeoutSec", "90"/);
  assert.match(overall, /IdleStabilityDurationSec = 20/);
  assert.match(overall, /\$IdleStabilityDurationSec/);
  assert.match(overall, /\[Math\]::Max\(\$TimeoutSec, 60\)/);
  assert.match(overall, /IncludeSoak/);
  assert.match(overall, /IncludeColdRelaunch/);
  assert.match(overall, /Proxy\s+\$null/);
  assert.match(overall, /ConvertTo-Json/);
  assert.match(overall, /originalCodexMainPids/);

  assert.match(overall, /Stop-Process -Id \$process\.Id -Force/);
  assert.doesNotMatch(overall, /Stop-Process[^\n\r]*(Anti-Codex|Antigravity|deepcodex-translator)/i);
  assert.doesNotMatch(overall, /Antigravity\.exe/);
  assert.doesNotMatch(overall, /chatgpt\.com/);
  assert.doesNotMatch(overall, /auth\/login/);
});

test("Anti-Codex ships a standalone real Manager button gate", () => {
  const managerButtons = readFileSync(resolve(root, "scripts", "test-anticodex-manager-real-buttons.ps1"), "utf8");
  const managerButtonHelper = readFileSync(resolve(root, "scripts", "test-anticodex-manager-button.mjs"), "utf8");

  assert.match(managerButtons, /test-anticodex-manager-button\.mjs/);
  assert.match(managerButtonHelper, /bootstrapManagerActionToken/);
  assert.match(managerButtonHelper, /MANAGER_BOOTSTRAP_MAX_ATTEMPTS = 5/);
  assert.match(managerButtonHelper, /managerBootstrapRetryBudgetMs/);
  assert.match(managerButtonHelper, /managerBootstrapRequestTimeoutMs/);
  assert.match(managerButtonHelper, /Manager bootstrap failed after/);
  assert.match(managerButtonHelper, /await sleep\(Math\.min\(1000, 250 \* attempt\)\)/);
  assert.match(managerButtonHelper, /error\?\.statusCode !== 403/);
  assert.match(managerButtonHelper, /postManagerAction\(actionName, \{ refreshToken: true \}\)/);
  assert.match(managerButtons, /viewLatestReports/);
  assert.match(managerButtons, /diagnosticsBundle/);
  assert.match(managerButtons, /mcpSkills/);
  assert.match(managerButtons, /pluginCapabilities/);
  assert.match(managerButtons, /\[ValidateSet\("mcpSkills", "pluginCapabilities", "viewLatestReports", "diagnosticsBundle"\)\]/);
  assert.match(managerButtons, /\$Actions = @\("pluginCapabilities", "mcpSkills"\)/);
  assert.match(managerButtons, /lastUiOnly -eq \$true/);
  assert.match(managerButtons, /ui-only manager button smoke\|ui-only-manager-button/);
  assert.match(managerButtons, /function Get-ManagerButtonActionResult/);
  assert.match(managerButtons, /\$_ -split ","/);
  assert.match(managerButtons, /latest-\$Name\.json/);
  assert.match(managerButtons, /New-ReportPaths "manager-real-buttons"/);
  assert.match(managerButtons, /Write-AntiCodexJsonReport/);
  assert.match(managerButtons, /UTF8Encoding\]::new\(\$false\)/);
  assert.match(managerButtons, /Resolve-CdpPort/);
  assert.match(managerButtons, /Start-Process -FilePath \$node/);
  assert.match(managerButtons, /\$process\.Kill\(\)/);
  assert.match(managerButtons, /Clear-ManagerButtonVerifierLock/);
  assert.match(managerButtons, /anticodex-manager-button\.lock/);
  assert.match(managerButtons, /function Invoke-ManagerButtonAction/);
  assert.match(managerButtons, /MaxAttempts/);
  assert.match(managerButtons, /Test-TransientManagerButtonFailure/);
  assert.match(managerButtons, /ECONNRESET\|manager bridge timed out/);
  assert.match(managerButtons, /--action/);
  assert.doesNotMatch(managerButtons, /--actions/);
  assert.match(managerButtons, /Invoke-ManagerButtonAction \$actionName/);
  assert.match(managerButtons, /\[Math\]::Max\(1, \$TimeoutSec \+ 20\)/);
  assert.match(managerButtons, /--compact/);
  assert.doesNotMatch(managerButtons, /Stop-Process/);
  assert.doesNotMatch(managerButtons, /chatgpt\.com/);
  assert.doesNotMatch(managerButtons, /auth\/login/);
});

test("Anti-Codex Manager button verifier waits for the embedded panel to finish rendering", () => {
  const verifier = readFileSync(resolve(root, "scripts", "test-anticodex-manager-button.mjs"), "utf8");

  assert.match(verifier, /args\.get\("--port"\)/);
  assert.match(verifier, /function discoverAntiCodexCdpPorts\(\)/);
  assert.match(verifier, /ProcessName -eq 'Anti-Codex\.exe'/);
  assert.match(verifier, /\[\.\.\.discoverAntiCodexCdpPorts\(\), 58318, 58317\]/);
  assert.match(verifier, /args\.get\("--actions"\)/);
  assert.match(verifier, /const actions = /);
  assert.match(verifier, /for \(const actionName of actions\)/);
  assert.match(verifier, /runManagerActionBatch/);
  assert.match(verifier, /closeHitAreaOk/);
  assert.match(verifier, /managerOpenedNewPage: false/);
  assert.match(verifier, /pageTargetCountBeforeManagerOpen/);
  assert.doesNotMatch(verifier, /spawnSync/);
  assert.match(verifier, /Runtime\.executionContextCreated/);
  assert.match(verifier, /Page\.getFrameTree/);
  assert.match(verifier, /pickVisiblePageContextId/);
  assert.match(verifier, /contextId: pageContextId/);
  assert.match(verifier, /Date\.now\(\) \+ 10000/);
  assert.match(verifier, /writeBigUInt64BE/);
  assert.match(verifier, /button && typeof window\.__ANTICODEX_RUN_MANAGER_ACTION__ === "function"/);
  assert.match(verifier, /elementFromPoint/);
  assert.match(verifier, /actionCenterHitsButton/);
  assert.match(verifier, /buttonPresent/);
  assert.match(verifier, /actionStarted/);
  assert.match(verifier, /function asciiJson/);
  assert.match(verifier, /acquireManagerButtonLock/);
  assert.match(verifier, /anticodex-manager-button\.lock/);
  assert.match(verifier, /releaseManagerButtonLock/);
  assert.match(verifier, /verificationMode/);
  assert.match(verifier, /uiOnlyBridgeSource/);
  assert.match(verifier, /lastUiOnly/);
  assert.match(verifier, /const initialUiOnlyFinished = uiOnlyMode/);
  assert.match(verifier, /initialUiOnlyFinished[\s\S]*\|\| uiOnlyFinished[\s\S]*\|\| initial\.busyAttr === "true"/);
  assert.match(verifier, /__ANTICODEX_MANAGER_BUTTON_REAL_BRIDGE__/);
  assert.match(verifier, /__ANTICODEX_MANAGER_BUTTON_ACTION_QUEUE__/);
  assert.match(verifier, /__ANTICODEX_MANAGER_BUTTON_ACTION_PROMISES__/);
  assert.match(verifier, /__ANTICODEX_RESOLVE_MANAGER_BUTTON_ACTION__/);
  assert.doesNotMatch(verifier, /window\.__ANTICODEX_MANAGER_ACTION_QUEUE__ = \[\]/);
  assert.match(verifier, /lastActionResult\?\.managerSummary \|\| ""/);
  assert.match(verifier, /function managerSummaryFromActionPayload/);
  assert.match(verifier, /actionName === "secondAccountLoginStatus"[\s\S]*\\u7b2c\\u4e8c Antigravity \\u8d26\\u53f7\\u72b6\\u6001\\u68c0\\u67e5/);
  assert.match(verifier, /actionName === "secondAccountLoginStatus"[\s\S]*operatorBlockingStage/);
  assert.match(verifier, /actionName === "secondAccountLoginStatus"[\s\S]*operatorNextStep/);
  assert.match(verifier, /operatorStepDisplayText/);
  assert.match(verifier, /open_elevated_windows_user_settings_then_rerun_prepare[\s\S]*\\u6253\\u5f00 Windows \\u8bbe\\u7f6e/);
  assert.match(verifier, /const realCallPassed = result\.mcp\?\.smoke\?\.realCall\?\.passed === true/);
  assert.match(verifier, /result\.mcp\?\.realCallPassed === true/);
  assert.match(verifier, /drainedPayloads\[item\.action\] = payload/);
  assert.match(verifier, /const drainedPayload = drainedPayloads\[actionName\] \|\| null/);
  assert.match(verifier, /lastAction: actionName/);
  assert.match(verifier, /managerSummaryFromActionPayload\(item\.action, payload\)/);
  assert.match(verifier, /__ANTICODEX_MANAGER_LAST_ACTION_RESULT__ = \{[\s\S]{0,220}managerSummary/);
  assert.match(verifier, /result\.removeAttribute\('data-anticodex-running'\)/);
  assert.match(verifier, /result\.textContent = \$\{JSON\.stringify\(managerSummary\)\}/);
  assert.match(verifier, /removeAttribute\('data-anticodex-busy'\)/);
  assert.match(verifier, /for \(const button of document\.querySelectorAll\('button\[data-action\]'\)\) button\.disabled = false/);
  assert.match(verifier, /return drainedPayloads/);
  assert.match(verifier, /latest\.lastAction === action/);
  assert.doesNotMatch(verifier, /if \(visibleFinished\) break/);
  assert.match(verifier, /const explicitActionSuccess = visibleFinished[\s\S]*\(latest\.lastAction === action \|\| Boolean\(drainedPayload\)\)/);
  assert.match(verifier, /drainedPayload\?\.ok !== false/);
  assert.match(verifier, /Number\(latest\.pendingCount \|\| 0\) === 0/);
  assert.match(verifier, /function remainingActionTimeoutMs/);
  assert.match(verifier, /Math\.min\(2500, remaining\)/);
  assert.match(verifier, /--verify-pending-reopen/);
  assert.match(verifier, /simulatePendingReopen/);
  assert.match(verifier, /pendingReopen/);
  assert.match(verifier, /closeHitAreaOk/);
  assert.match(verifier, /closeHitResults/);
  assert.match(verifier, /managerOpenedNewPage === false/);
  assert.match(verifier, /pageTargetCountAfterManagerOpen/);
  assert.match(verifier, /lateText === pendingReopen\.lateRecord\?\.managerSummary/);
  assert.ok(verifier.includes(String.raw`replace(/[^\x00-\x7F]/gu`));
});

test("Anti-Codex ships a read-only runtime config verifier", () => {
  const runtimeConfig = readFileSync(resolve(root, "scripts", "test-anticodex-runtime-config.ps1"), "utf8");
  const launcher = readFileSync(resolve(root, "scripts", "start-deepcodex.ps1"), "utf8");

  assert.match(runtimeConfig, /codex-home-deepseek-app/);
  assert.match(runtimeConfig, /config\.toml/);
  assert.match(runtimeConfig, /cli_auth_credentials_store/);
  assert.match(runtimeConfig, /model_catalog_json/);
  assert.match(runtimeConfig, /openai_base_url/);
  assert.match(runtimeConfig, /chatgpt_base_url/);
  assert.match(runtimeConfig, /responses_websockets/);
  assert.match(runtimeConfig, /responses_websockets_v2/);
  assert.match(runtimeConfig, /plugin_sharing/);
  assert.match(runtimeConfig, /remote_plugin/);
  assert.match(runtimeConfig, /local Anti-Codex gateway/);
  assert.match(runtimeConfig, /ConvertTo-Json/);
  assert.match(launcher, /CODEX_APP_SERVER_FORCE_CLI\s*=\s*"1"/);
  assert.match(launcher, /Remove-Item Env:CODEX_APP_SERVER_WS_URL/);
  assert.doesNotMatch(runtimeConfig, /Stop-Process/);
  assert.doesNotMatch(runtimeConfig, /Start-Process/);
});

test("Anti-Codex ships a read-only websocket fallback verifier", () => {
  const websocket = readFileSync(resolve(root, "scripts", "test-anticodex-websocket-fallback.ps1"), "utf8");
  const server = readFileSync(resolve(root, "translator", "adaptive-server.mjs"), "utf8");

  assert.match(websocket, /Upgrade: websocket/);
  assert.match(websocket, /Sec-WebSocket-Key/);
  assert.match(websocket, /Sec-WebSocket-Protocol: codex\.responses\.v1/);
  assert.match(websocket, /\/v1\/responses/);
  assert.match(websocket, /\/codex\/responses/);
  assert.match(websocket, /function Invoke-WebSocketUpgradeProbeWithRetry/);
  assert.match(websocket, /failed after \$MaxAttempts attempts/);
  assert.match(websocket, /probeResults/);
  assert.match(websocket, /HTTP\/1\\\.1 101/);
  assert.match(websocket, /acceptedRelayWebsocket/);
  assert.match(websocket, /http_relay_websocket/);
  assert.match(websocket, /\/anticodex\/diagnostics/);
  assert.match(websocket, /responsesWebSocket/);
  assert.match(websocket, /lastUpgrade/);
  assert.match(websocket, /secWebSocketProtocol/);
  assert.match(websocket, /TcpClient/);
  assert.match(websocket, /ConvertTo-Json/);
  assert.match(server, /function responsesWebSocketRelayHeaders\(req\)/);
  assert.match(server, /"session_id"/);
  assert.match(server, /"x-codex-window-id"/);
  assert.match(server, /attachResponsesWebSocket\(req, socket, url\.pathname\)/);
  assert.match(server, /RESET_CANCELLED_RESPONSE_IDS/);
  assert.match(server, /RESET_CANCELLED_REQUEST_FINGERPRINTS/);
  assert.match(server, /RESET_CANCELLED_RESPONSE_TTL_MS/);
  assert.match(server, /rememberResetCancelledResponseIds\(before\.sessionLock\?\.activeResponseIds/);
  assert.match(server, /rememberResetCancelledRequestFingerprints\(before\.activeRequests\?\.entries/);
  assert.match(server, /resetReplayFingerprint\(parsed\)/);
  assert.match(server, /includeEntries:\s*true/);
  assert.match(server, /resetCancelledPreviousResponseFailure\(parsed\)/);
  assert.match(server, /RESET_CANCELLED_RESPONSE_TTL_MS/);
  assert.match(server, /resetFingerprint:\s*true/);
  assert.match(server, /anticodex_session_reset/);
  assert.match(server, /responseType:\s*"http_relay_websocket"/);
  assert.match(server, /for await \(const chunk of response\.body\)/);
  assert.match(server, /decoder\.decode\(chunk, \{ stream: true \}\)/);
  assert.match(server, /socket\.write\(webSocketFrame\(0x9, "anticodex"\)\)/);
  assert.doesNotMatch(server, /pendingPayloads\.length === 0\)\s*closeSocket\(\)/);
  assert.match(server, /socket\.setTimeout\(5 \* 60 \* 1000/);
  assert.doesNotMatch(server, /const text = await response\.text\(\);\s*if \(!response\.ok\)/);
  assert.doesNotMatch(server, /await relayResponsesHttpToWebSocket\(\{ pathname, payload: frame\.payload\.toString\("utf8"\), socket \}\);\s*if \(!closed\) socket\.end/);
  assert.doesNotMatch(websocket, /Stop-Process/);
  assert.doesNotMatch(websocket, /Start-Process/);
  assert.doesNotMatch(websocket, /chatgpt\.com/);
  assert.doesNotMatch(websocket, /auth\/login/);
});

test("Anti-Codex ships a source-only preflight gate before install or deploy", () => {
  const preflight = readFileSync(resolve(root, "scripts", "test-anticodex-source-preflight.ps1"), "utf8");
  const install = readFileSync(resolve(root, "scripts", "install-anticodex.ps1"), "utf8");
  const sync = readFileSync(resolve(root, "scripts", "sync-anticodex.ps1"), "utf8");

  assert.match(preflight, /latest-\$Name\.json/);
  assert.match(preflight, /Save-JsonReport "source-preflight"/);
  assert.match(preflight, /noTraffic = \$true/);
  assert.match(preflight, /usedRealTraffic = \$false/);
  assert.match(preflight, /behaviorCovered = \(\$failures\.Count -eq 0\)/);
  assert.match(preflight, /coverageKind = "source-no-traffic"/);
  assert.match(preflight, /node --check/);
  assert.match(preflight, /Test-LogDbGuardSelfTest/);
  assert.match(preflight, /protect-anticodex-log-db\.mjs/);
  assert.match(preflight, /Log database guard self-test failed/);
  assert.match(preflight, /Test-LocalConnectorVerifier/);
  assert.match(preflight, /test-anticodex-local-connectors\.mjs/);
  assert.match(preflight, /"--report-root", \$ReportRoot/);
  assert.match(preflight, /--self-test/);
  assert.match(preflight, /\$scanRoots = @\("translator", "scripts"\)/);
  assert.match(preflight, /Get-ChildItem[\s\S]+-Recurse[\s\S]+\.Extension -in @\("\.mjs", "\.js"\)/);
  assert.match(preflight, /Get-ChildItem[\s\S]+translator\\tests/);
  assert.match(preflight, /Parser\]::ParseFile/);
  assert.match(preflight, /rev-parse --is-inside-work-tree/);
  assert.match(preflight, /not a git worktree/);
  assert.match(preflight, /git diff --check/);
  assert.match(preflight, /warningsOnly/);
  assert.match(preflight, /function Test-PublicDocumentationContracts/);
  assert.match(preflight, /\$checks\["publicDocumentation"\] = Test-PublicDocumentationContracts/);
  assert.match(preflight, /function Test-ManagerBridgeSelfTest/);
  assert.match(preflight, /\$checks\["managerBridgeSelfTest"\] = Test-ManagerBridgeSelfTest/);
  assert.match(preflight, /docs\\ADAPTIVE_ONE_API_STACK\.md/);
  assert.match(preflight, /docs\\marketing\\video-script\.md/);
  assert.match(preflight, /antigravity-entitlement-model-text/);
  assert.match(preflight, /Antigravity entitlement supplies model text/);
  assert.match(preflight, /no-antigravity-desktop-default-route/);
  assert.match(preflight, /antigravity-cli-target-desktop-compat-boundary/);
  assert.match(preflight, /no-native-bridge-default-wording/);
  assert.doesNotMatch(preflight, /Antigravity Desktop provider by default/);
  assert.match(preflight, /provider profile/);
  assert.match(preflight, /connector-backed app tools/);
  assert.match(preflight, /UTF8Encoding\]::new\(\$false\)/);
  assert.match(preflight, /Write-AntiCodexJsonReport/);
  assert.match(preflight, /SkipFullRegression/);
  assert.match(install, /test-anticodex-source-preflight\.ps1/);
  assert.match(install, /Invoke-AntiCodexSourcePreflight/);
  assert.match(install, /\$global:LASTEXITCODE = 0[\s\S]{0,80}& \$SOURCE_PREFLIGHT_SCRIPT -SkipFullRegression/);
  assert.match(install, /source preflight failed\. Installation was stopped before copying the host/i);
  assert.match(sync, /test-anticodex-source-preflight\.ps1/);
  assert.match(sync, /source preflight failed\. Sync was stopped before building an update candidate/i);
  assert.doesNotMatch(preflight, /Start-Process[^\n]*(Anti-Codex|Antigravity)/i);
  assert.doesNotMatch(preflight, /Codex\.exe|Antigravity\.exe|ChatGPT|chatgpt\.com|auth\/login/);
});

test("Anti-Codex ships a Codex internal Responses stream verifier", () => {
  const verifier = readFileSync(resolve(root, "scripts", "test-anticodex-codex-responses.ps1"), "utf8");
  const server = readFileSync(resolve(root, "translator", "adaptive-server.mjs"), "utf8");

  assert.match(server, /\/codex\/responses/);
  assert.match(verifier, /\/codex\/responses/);
  assert.match(verifier, /response\.created/);
  assert.match(verifier, /response\.completed/);
  assert.match(verifier, /请用中文/);
  assert.match(verifier, /\\u4e00-\\u9fff/);
  assert.match(verifier, /\$finalText\s+-match\s+"DeepCodex"/);
  assert.match(verifier, /\/anticodex\/model-routes/);
  assert.match(verifier, /tool protocol markup/);
  assert.match(verifier, /ReportRoot/);
  assert.match(verifier, /Save-Report/);
  assert.match(verifier, /latest-codex-responses\.json/);
  assert.match(verifier, /reportName = "codex-responses"/);
  assert.match(verifier, /Proxy\s+\$null/);
  assert.doesNotMatch(verifier, /Stop-Process/);
  assert.doesNotMatch(verifier, /Start-Process/);
  assert.doesNotMatch(verifier, /chatgpt\.com/);
  assert.doesNotMatch(verifier, /auth\/login/);
});

test("Anti-Codex ships a model-switch history verifier that preserves array input", () => {
  const verifier = readFileSync(resolve(root, "scripts", "test-anticodex-model-switch-history.ps1"), "utf8");

  assert.match(verifier, /previous_response_id/);
  assert.match(verifier, /MODEL_SWITCH_HISTORY_/);
  assert.match(verifier, /return ,\$items/);
  assert.match(verifier, /second response did not preserve previous_response_id history after model switch/);
  assert.match(verifier, /model route audit did not record the switched model/);
  assert.doesNotMatch(verifier, /return @\(/);
});

test("Anti-Codex ships a read-only UI state verifier", () => {
  const uiScript = readFileSync(resolve(root, "scripts", "test-anticodex-ui-state.mjs"), "utf8");
  const uiWrapper = readFileSync(resolve(root, "scripts", "test-anticodex-ui-state.ps1"), "utf8");
  const managerInject = readFileSync(resolve(root, "scripts", "anticodex-manager-inject.js"), "utf8");

  assert.match(uiScript, /Runtime\.evaluate/);
  assert.match(uiScript, /Runtime\.terminateExecution/);
  assert.match(uiScript, /const loadedDeadline = Date\.now\(\) \+ \$\{Math\.max\(1000, managerProbeTimeoutMs\)\}/);
  assert.match(uiWrapper, /\[switch\]\$Fast/);
  assert.match(uiWrapper, /\[int\]\$ManagerProbeTimeoutSec = 0/);
  assert.match(uiWrapper, /\$effectiveManagerProbeTimeoutSec = if \(\$ManagerProbeTimeoutSec -gt 0\)/);
  assert.match(uiWrapper, /function Test-CdpPort/);
  assert.match(uiWrapper, /\/json\/version/);
  assert.match(uiWrapper, /webSocketDebuggerUrl/);
  assert.match(uiWrapper, /function Get-AntiCodexProcessCdpPorts/);
  assert.match(uiWrapper, /Get-CimInstance Win32_Process -Filter "Name = 'Anti-Codex\.exe'"/);
  assert.match(uiWrapper, /--remote-debugging-port=\(\\d\+\)/);
  assert.match(uiWrapper, /No usable Anti-Codex CDP port found/);
  assert.match(uiWrapper, /"--manager-probe-timeout-ms"/);
  assert.match(uiWrapper, /\$effectiveManagerProbeTimeoutSec \* 1000/);
  assert.match(uiWrapper, /"--fast", "1"/);
  assert.match(uiWrapper, /Start-Process -FilePath \$node/);
  assert.match(uiWrapper, /\$process\.WaitForExit\(\$waitMs\)/);
  assert.match(uiWrapper, /UI verifier timed out after \$TimeoutSec seconds/);
  assert.match(uiWrapper, /\$process\.Kill\(\)/);
  assert.match(uiWrapper, /Get-Content -LiteralPath \$stdoutPath -Encoding UTF8/);
  assert.match(uiWrapper, /if \(\$parsed\.ok -eq \$true\) \{ exit 0 \}/);
  assert.match(uiScript, /fastUiState/);
  assert.match(uiScript, /Date\.now\(\) - fs\.statSync\(lockPath\)\.mtimeMs < 5000/);
  assert.match(uiScript, /managerProbeTimeoutMs/);
  assert.match(uiScript, /--manager-probe-timeout-ms/);
  assert.match(uiScript, /dynamicProbeUnavailable/);
  assert.match(uiScript, /context-probe-and-manager-page/);
  assert.match(uiScript, /manager overlay dynamic probe skipped/);
  assert.match(uiScript, /staticContextCoversManager/);
  assert.match(uiScript, /manager-inject-skipped-current-context/);
  assert.match(uiScript, /manager-dynamic-skipped-static-context/);
  assert.match(uiScript, /static Manager page and live context evidence are current/);
  assert.match(uiScript, /runtimeParams\(managerInjectSource, \{\s+awaitPromise: false,/);
  assert.doesNotMatch(uiScript, /Math\.max\(timeoutMs, 120000\)/);
  assert.doesNotMatch(uiScript, /Math\.max\(timeoutMs, 40000\)/);
  assert.doesNotMatch(uiScript, /Math\.max\(timeoutMs, 20000\)/);
  assert.match(uiScript, /function getJson\(url, requestTimeoutMs = timeoutMs\)/);
  assert.match(uiScript, /getJson\(`\$\{baseUrl\}\/health`, Math\.max\(timeoutMs, fastUiState \? 15000 : timeoutMs\)\)/);
  assert.match(uiScript, /skippedDeepProbe/);
  assert.match(uiScript, /coveredBy: "fast-ui-state"/);
  assert.match(uiScript, /findDefaultContextId/);
  assert.match(uiScript, /contextId/);
  assert.match(uiScript, /const shortUiText = \(\) =>/);
  assert.match(uiScript, /querySelectorAll\(selectors\.join\(","\)\)\)\.slice\(0, 240\)/);
  assert.match(uiScript, /hasLoginText/);
  assert.doesNotMatch(uiScript, /auth\\\/login\|ChatGPT 鐧诲綍\|鐧诲綍 ChatGPT/);
  assert.match(uiScript, /auth\\\/login\|鐧诲綍 ChatGPT\|Sign in to ChatGPT/);
  assert.match(uiScript, /hasReconnectText/);
  assert.match(uiScript, /reconnectPattern/);
  assert.match(uiScript, /staleTranscriptPattern/);
  assert.match(uiScript, /reconnectEvidence/);
  assert.match(uiScript, /historicalReconnectEvidence/);
  assert.match(uiScript, /data-thread-find-target='conversation'/);
  assert.match(uiScript, /pageStateFromContextProbe/);
  assert.match(uiScript, /fallbackFromContextProbe/);
  assert.match(uiScript, /hasModelEvidence/);
  assert.match(uiScript, /controls\.includes\(label\)/);
  assert.doesNotMatch(uiScript, /document\.body \? document\.body\.innerText\.slice\(0, 1200\)/);
  assert.match(uiScript, /modelControlsText/);
  assert.match(uiScript, /contextProbeHasModelEvidence/);
  assert.match(uiScript, /modelIds\.includes\(upstreamModel\)/);
  assert.match(uiScript, /contextProbePageState/);
  assert.doesNotMatch(uiScript, /const text = ""/);
  assert.doesNotMatch(uiScript, /hasReconnectText:\s*false/);
  assert.match(uiScript, /anticodex-manager-overlay/);
  assert.match(uiScript, /manager overlay changed CDP target count/);
  assert.match(uiScript, /in-app manager function is not injected/);
  assert.match(uiScript, /ariaLabel/);
  assert.match(uiScript, /closeText/);
  assert.match(uiScript, /headingText/);
  assert.match(uiScript, /hasEmbeddedPanel/);
  assert.match(uiScript, /hasIframe/);
  assert.match(uiScript, /hasEndpointFetchFailure/);
  assert.match(uiScript, /in-app manager still shows endpoint fetch failure/);
  assert.match(uiScript, /mojibakePattern/);
  assert.match(uiScript, /mojibakeMatch/);
  assert.match(uiScript, /in-app manager rendered mojibake text/);
  assert.match(uiScript, /main page rendered mojibake text/);
  assert.match(uiScript, /manager page source contains mojibake text/);
  assert.match(uiScript, /in-app manager is missing MCP\/Skill app-tool registry evidence/);
  assert.match(uiScript, /manager page is missing MCP\/Skill app-tool registry evidence/);
  assert.match(uiScript, /plugin\/app action summary can hide metadata-only/);
  assert.match(uiScript, /managerProbeAttempt/);
  assert.match(uiScript, /exceptionDetails/);
  assert.match(uiScript, /manager overlay probe did not return a value/);
  assert.doesNotMatch(uiScript, /actionProbeSkippedByFallback/);
  assert.doesNotMatch(uiScript, /closeCenterHitsButton:\s*true/);
  assert.match(uiScript, /anticodex-manager-button\.lock/);
  assert.match(uiScript, /acquireManagerButtonLock/);
  assert.match(uiScript, /releaseManagerButtonLock/);
  assert.match(uiScript, /isLockOwnerAlive/);
  assert.match(uiScript, /process\.kill\(pid, 0\)/);
  assert.match(uiScript, /actionCount/);
  assert.match(uiScript, /managerPage/);
  assert.match(uiScript, /getText/);
  assert.match(uiScript, /hasZhLang/);
  assert.match(uiScript, /hasNoTrafficNotice/);
  assert.match(uiScript, /hasRefreshStatusButton/);
  assert.match(uiScript, /hasRefreshModelsButton/);
  assert.match(uiScript, /hasAccountProxyButton/);
  assert.match(uiScript, /hasSyncReadinessButton/);
  assert.match(uiScript, /hasUpdateCheckButton/);
  assert.match(uiScript, /hasUpdateCheckAction/);
  assert.match(uiScript, /hasSourcePreflightButton/);
  assert.match(uiScript, /hasSourcePreflightAction/);
  assert.match(uiScript, /hasRepairShortcutsAction/);
  assert.match(uiScript, /hasSyncHostButton/);
  assert.match(uiScript, /hasSyncHostAction/);
  assert.match(uiScript, /hasSyncStatusCard/);
  assert.match(uiScript, /hasNativeCodexVersionLabel/);
  assert.match(uiScript, /hasAntiCodexVersionLabel/);
  assert.match(uiScript, /hasUpdateStatusLabel/);
  assert.match(uiScript, /hasRollbackPointLabel/);
  assert.match(uiScript, /hasSyncDescriptionLabel/);
  assert.match(uiScript, /hasMcpSkillsButton/);
  assert.match(uiScript, /hasPluginCapabilitiesButton/);
  assert.match(uiScript, /hasRefreshFeaturesButton/);
  assert.match(uiScript, /hasRefreshFeaturesAction/);
  assert.match(uiScript, /hasOverallNoTrafficButton/);
  assert.match(uiScript, /hasDiagnosticsBundleButton/);
  assert.match(uiScript, /hasViewLatestReportsButton/);
  assert.match(uiScript, /hasPostVerificationButton/);
  assert.match(uiScript, /hasLongTasksStatusCard/);
  assert.match(uiScript, /hasPluginStatusCard/);
  assert.doesNotMatch(uiScript, /Date\.now\(\) \+ 35000/);
  assert.match(uiScript, /Math\.max\(timeoutMs, managerProbeTimeoutMs\)/);
  assert.match(uiScript, /hasLoadedModels/);
  assert.match(uiScript, /hasLoadedCapabilities/);
  assert.match(uiScript, /const hasLoadedCapabilities = \/MCP/);
  assert.match(uiScript, /&& !\/MCP/);
  assert.match(uiScript, /if \(before\) return null/);
  assert.match(uiScript, /return window\.__ANTICODEX_OPEN_MANAGER__\(\)/);
  assert.match(uiScript, /managerStillLoading[\s\S]*\\u672c\\u5730\\u72b6\\u6001\\u672a\\u5c31\\u7eea/);
  assert.match(uiScript, /hasMcpSessionToolBoundary/);
  assert.match(uiScript, /hasPluginMetadataBoundary/);
  assert.match(uiScript, /hasSnapshotFreshness/);
  assert.match(uiScript, /hasSnapshotRefreshState/);
  assert.match(managerInject, /DIAGNOSTICS_FETCH_TIMEOUT_MS/);
  assert.match(managerInject, /DIAGNOSTICS_FETCH_TIMEOUT_MS = 30000/);
  assert.match(managerInject, /LOAD_SNAPSHOT_TIMEOUT_MS = 30000/);
  assert.match(managerInject, /function hasCompleteManagerSnapshot/);
  assert.match(managerInject, /Number\(localFeatures\.mcp\?\.count\) > 0/);
  assert.match(managerInject, /safeJson\("\/anticodex\/diagnostics", \{ timeoutMs: DIAGNOSTICS_FETCH_TIMEOUT_MS \}\)/);
  assert.match(uiScript, /hasSnapshotRefreshState[\s\S]{0,400}\\u539f\\u751f Codex/);
  assert.match(uiScript, /hasRouteSummaryCard/);
  assert.match(uiScript, /hasRouteProviderFields/);
  assert.match(uiScript, /in-app manager route summary is missing third-party provider\/protocol\/transport fields/);
  assert.match(uiScript, /in-app manager route empty state collapses provider fields/);
  assert.match(uiScript, /hasSyncVersionFields/);
  assert.match(uiScript, /hasSyncSafetyText/);
  assert.match(uiScript, /hasRollbackStatus/);
  assert.match(uiScript, /button\[data-action="upstreamConfig"\]/);
  assert.match(uiScript, /upstreamConfigOpened/);
  assert.match(uiScript, /upstreamConfigEmbeddedInOverlay/);
  assert.match(uiScript, /upstreamConfigSaveInitiallyDisabled/);
  assert.match(uiScript, /upstreamConfigHasSafeWarning/);
  assert.match(uiScript, /upstreamConfigHasExpectedControls/);
  assert.match(uiScript, /hasManagerActionEndpoint/);
  assert.match(uiScript, /hasActionResult/);
  assert.match(uiScript, /hasDiagnosticsBundleLongTaskResultSummary/);
  assert.match(uiScript, /diagnosticsSummary/);
  assert.match(uiScript, /manager page missing diagnostics bundle long-task result summary/);
  assert.match(uiScript, /hasRouteProviderFields/);
  assert.match(uiScript, /manager page route summary is missing third-party provider\/protocol\/transport fields/);
  assert.match(uiScript, /manager page route empty state collapses provider fields/);
  assert.match(uiScript, /closeHitGridAll/);
  assert.match(uiScript, /closeHitSamples/);
  assert.match(uiScript, /full hit grid is incomplete/);
  assert.match(uiScript, /manager page missing MCP\/Skill check button/);
  assert.match(uiScript, /manager page missing plugin\/app check button/);
  assert.match(uiScript, /manager page missing plugin\/app status card/);
  assert.match(uiScript, /manager page missing long-task status card/);
  assert.match(uiScript, /latestLogLine/);
  assert.match(uiScript, /logAgeMs/);
  assert.match(uiScript, /manager page missing latest reports button/);
  assert.match(uiScript, /copyTextToClipboard/);
  assert.match(uiScript, /anticodex-copy-result/);
  assert.match(uiScript, /manager page missing refresh local features button/);
  assert.match(uiScript, /manager page missing refreshFeatures action binding/);
  assert.match(uiScript, /snapshotStalenessNotice/);
  assert.match(uiScript, /source_changed/);
  assert.match(uiScript, /manager page missing update check button/);
  assert.match(uiScript, /manager page missing updateCheck action binding/);
  assert.match(uiScript, /manager page missing syncHost action binding/);
  assert.match(uiScript, /manager page missing sync status card/);
  assert.match(uiScript, /manager page missing native Codex version label/);
  assert.match(uiScript, /manager page missing Anti-Codex version label/);
  assert.match(uiScript, /manager page missing update status label/);
  assert.match(uiScript, /manager page missing rollback point label/);
  assert.match(uiScript, /manager page missing sync safety description label/);
  assert.match(uiScript, /manager page missing Codex\/Anti-Codex sync version fields/);
  assert.match(uiScript, /manager page missing safe sync replacement explanation/);
  assert.match(uiScript, /manager page missing rollback status/);
  assert.match(uiScript, /manager page missing Chinese no-login\/no-traffic notice/);
  assert.match(uiScript, /in-app manager third-party API config panel did not open/);
  assert.match(uiScript, /in-app manager third-party API config panel is not embedded in the overlay/);
  assert.match(uiScript, /in-app manager third-party API save button is enabled before a successful connection test/);
  assert.match(uiScript, /in-app manager third-party API config panel is missing no-fallback\/no-history-loss warning/);
  assert.match(uiScript, /in-app manager third-party API config panel is missing protocol\/key\/test\/save\/restore controls/);
  assert.match(uiScript, /in-app manager does not explain that MCP callability follows the current session tool list/);
  assert.match(uiScript, /in-app manager does not distinguish plugin metadata from callable tools/);
  assert.match(uiScript, /in-app manager local feature snapshot freshness is missing/);
  assert.match(uiScript, /in-app manager local feature snapshot refresh guidance is missing/);
  assert.match(uiScript, /in-app manager embedded panel is missing/);
  assert.match(uiScript, /in-app manager still uses an iframe/);
  assert.ok(uiScript.includes(String.raw`Anti-Codex \u7ba1\u7406`) || uiScript.includes("Anti-Codex " + String.fromCharCode(0x7ba1, 0x7406)));
  assert.ok(uiScript.includes(String.raw`\u5173\u95ed`) || uiScript.includes(String.fromCharCode(0x5173, 0x95ed)));
  assert.ok(uiScript.includes(String.raw`\u5237\u65b0\u72b6\u6001`) || uiScript.includes(String.fromCharCode(0x5237, 0x65b0, 0x72b6, 0x6001)));
  assert.ok(uiScript.includes(String.raw`\u5237\u65b0\u6a21\u578b`) || uiScript.includes(String.fromCharCode(0x5237, 0x65b0, 0x6a21, 0x578b)));
  assert.ok(uiScript.includes(String.raw`\u68c0\u67e5\u66f4\u65b0`) || uiScript.includes(String.fromCharCode(0x68c0, 0x67e5, 0x66f4, 0x65b0)));
  assert.ok(uiScript.includes(String.raw`\u540c\u6b65 Codex \u66f4\u65b0`));
  assert.ok(uiScript.includes(String.raw`\u539f\u751f Codex \u7248\u672c`));
  assert.ok(uiScript.includes(String.raw`Anti-Codex \u7248\u672c`));
  assert.ok(uiScript.includes(String.raw`\u66f4\u65b0\u72b6\u6001`));
  assert.ok(uiScript.includes(String.raw`\u56de\u6eda\u70b9`));
  assert.ok(uiScript.includes(String.raw`\u8bf4\u660e`));
  assert.ok(uiScript.includes(String.raw`\u9a8c\u8bc1\u901a\u8fc7\u624d\u66ff\u6362`));
  assert.ok(uiScript.includes(String.raw`\u5931\u8d25\u4e0d\u4f1a\u8986\u76d6\u5f53\u524d Anti-Codex`));
  assert.match(uiScript, /upstreamConfigHasSafeWarning/);
  assert.match(uiScript, /upstreamConfigHasExpectedControls/);
  assert.match(uiScript, /upstreamConfigTextSample/);
  assert.match(uiScript, /anticodex-manager-button/);
  assert.match(uiScript, /in-app manager still exposes the removed floating Manager button/);
  assert.doesNotMatch(uiScript, /hasButton:\s*!!button\s*\|\|\s*before/);
  assert.match(uiScript, /\/anticodex\/manager/);
  assert.match(uiScript, /\/anticodex\/manager\/open/);
  assert.match(uiScript, /matchedModelText/);
  assert.match(uiScript, /managerOverlay\?\.textSample/);
  assert.match(uiScript, /modelEvidenceText/);
  assert.match(uiScript, /validateCatalogModels/);
  assert.match(uiScript, /catalog missing visible model id/);
  assert.match(uiScript, /display_name lacks numeric version/);
  assert.match(uiScript, /wrong reasoning suffix/);
  assert.match(uiScript, /catalogLabels/);
  assert.match(uiScript, /modelIds/);
  assert.match(uiScript, /upstreamMode/);
  assert.match(uiScript, /third-party upstream UI verification missing protocol/);
  assert.match(uiScript, /third-party upstream UI verification missing model/);
  assert.match(uiScript, /third-party mode keeps current provider model evidence/);
  assert.match(uiScript, /third-party mode skips Antigravity catalog-only validation/);
  assert.match(uiScript, /third-party mode skips native Antigravity thinking-budget UI assertion/);
  assert.match(uiScript, /function asciiJson/);
  assert.ok(uiScript.includes(String.raw`replace(/[^\x00-\x7F]/gu`));
  assert.match(uiScript, /Anti-Codex/);
  assert.match(uiWrapper, /CdpPort/);
  assert.match(uiWrapper, /antigravity-model-catalog\.json/);
  assert.match(uiWrapper, /cua_node\\bin\\node\.exe/);
  assert.match(uiWrapper, /ConvertFrom-Json -ErrorAction Stop/);
  assert.doesNotMatch(uiScript, /click\(/i);
  assert.match(uiWrapper, /Start-Process -FilePath \$node/);
  assert.match(uiWrapper, /\$process\.Kill\(\)/);
  assert.doesNotMatch(uiWrapper, /auth\/login/);
});

test("Anti-Codex Manager source does not carry known mojibake text", () => {
  const adaptiveServer = readFileSync(resolve(root, "translator", "adaptive-server.mjs"), "utf8");
  const managerInject = readFileSync(resolve(root, "scripts", "anticodex-manager-inject.js"), "utf8");
  const knownMojibake = /闇€|楠岃|宸插|娑堣|浠ｇ悊|杩愯|妫€|鍚庡/;

  assert.doesNotMatch(adaptiveServer, knownMojibake);
  assert.doesNotMatch(managerInject, knownMojibake);
});

test("Anti-Codex ships a read-only UI idle stability verifier", () => {
  const idle = readFileSync(resolve(root, "scripts", "test-anticodex-ui-idle-stability.ps1"), "utf8");
  const overall = readFileSync(resolve(root, "scripts", "test-anticodex-installed-overall.ps1"), "utf8");

  assert.match(idle, /test-anticodex-ui-state\.ps1/);
  assert.match(idle, /hasReconnectText/);
  assert.match(idle, /hasLoginText/);
  assert.match(idle, /Get-Content -LiteralPath \$stdoutPath -Encoding UTF8/);
  assert.match(idle, /Get-Content -LiteralPath \$stderrPath -Encoding UTF8/);
  assert.match(idle, /translator process changed during idle/);
  assert.match(idle, /Anti-Codex main process changed during idle/);
  assert.match(idle, /manager injection watcher count changed during idle/);
  assert.match(idle, /expected one manager injection watcher/);
  assert.match(idle, /legacy manager injection watcher still running/);
  assert.match(idle, /expected at most one manager injection watcher/);
  assert.match(idle, /managerWatcherPids/);
  assert.match(idle, /legacyManagerWatcherPids/);
  assert.match(idle, /deepcodex-cdp-inject\\\.mjs/);
  assert.match(idle, /anticodex-manager-inject\\\.js/);
  assert.match(idle, /--watch/);
  assert.match(idle, /ConvertFrom-Json -ErrorAction Stop/);
  assert.match(idle, /function Get-RemainingIdleBudgetMs/);
  assert.match(idle, /UI state verifier timed out after \$RequestTimeoutSec seconds/);
  assert.match(idle, /\+ 5000\)/);
  assert.match(idle, /\$process\.WaitForExit\(\$waitMs\)/);
  assert.match(idle, /\$process\.Refresh\(\)/);
  assert.match(idle, /\$process\.Kill\(\)/);
  assert.match(idle, /uiFailures/);
  assert.match(idle, /uiExitCode/);
  assert.match(idle, /\$ui\.PSObject\.Properties\.Name -contains "exitCode"/);
  assert.doesNotMatch(idle, /Has-Property/);
  assert.match(idle, /transientUiFailures/);
  assert.match(idle, /UI state was not ready during warmup/);
  assert.match(idle, /UI state never reached ready during idle window/);
  assert.match(idle, /uiSuccessCount/);
  assert.match(idle, /\$sleepMs = \[Math\]::Min/);
  assert.match(idle, /New-ReportPaths "ui-idle-stability"/);
  assert.match(overall, /test-anticodex-ui-idle-stability\.ps1/);
  assert.match(overall, /UI idle stability verification/);
  assert.match(overall, /IdleStabilityIntervalSec = 5/);
  assert.doesNotMatch(idle, /Stop-Process|auth\/login|click\(/i);
});

test("UI idle stability verifier bounds a slow child UI state check", async () => {
  const tempRoot = mkdtempSync(resolve(os.tmpdir(), "anticodex-ui-idle-budget-"));
  const runtimeRoot = resolve(tempRoot, "runtime");
  const scriptsRoot = resolve(runtimeRoot, "scripts");
  const reportRoot = resolve(tempRoot, "reports");
  mkdirSync(scriptsRoot, { recursive: true });
  writeFileSync(resolve(scriptsRoot, "test-anticodex-ui-state.ps1"), [
    "param([int]$TimeoutSec = 8)",
    "Start-Sleep -Seconds ([Math]::Max(5, $TimeoutSec + 7))",
    "'{\"ok\":true,\"page\":{\"hasReconnectText\":false,\"hasLoginText\":false},\"matchedModelText\":\"fake\"}'",
  ].join("\n"), "utf8");
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, upstream: "antigravity-desktop", accountReady: true, modelCount: 1 }));
  });
  await new Promise((resolveServer, rejectServer) => {
    server.once("error", rejectServer);
    server.listen(0, "127.0.0.1", resolveServer);
  });
  try {
    const port = server.address().port;
    const startedAt = Date.now();
    const result = spawnSync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy", "Bypass",
      "-File", resolve(root, "scripts", "test-anticodex-ui-idle-stability.ps1"),
      "-BaseUrl", `http://127.0.0.1:${port}`,
      "-RuntimeRoot", runtimeRoot,
      "-ReportRoot", reportRoot,
      "-DurationSec", "5",
      "-IntervalSec", "5",
      "-TimeoutSec", "2",
      "-SkipManagerActionProbe",
    ], { encoding: "utf8", timeout: 15000 });
    const elapsedMs = Date.now() - startedAt;
    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.ok(elapsedMs < 12000, `UI idle verifier took ${elapsedMs}ms`);
    const report = JSON.parse(readFileSync(resolve(reportRoot, "latest-ui-idle-stability.json"), "utf8"));
    assert.equal(report.ok, false);
    assert.ok(report.failures.some((failure) => failure.includes("UI state never reached ready")));
    assert.ok(report.transientUiFailures.some((failure) => failure.includes("warmup")));
    assert.equal(report.samples[0].uiOk, false);
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("Anti-Codex ships a read-only diagnostics verifier", () => {
  const diagnostics = readFileSync(resolve(root, "scripts", "test-anticodex-diagnostics.ps1"), "utf8");
  const collector = readFileSync(resolve(root, "scripts", "collect-anticodex-diagnostics.ps1"), "utf8");

  assert.match(diagnostics, /\/anticodex\/diagnostics/);
  assert.match(diagnostics, /\[switch\]\$VerifyBundle/);
  assert.match(diagnostics, /\[string\]\$VerifyReportsSummary/);
  assert.match(diagnostics, /function Test-ReportsSummary/);
  assert.match(diagnostics, /function Test-ReleaseGateApprovalAndOfflineEvidence/);
  assert.match(diagnostics, /function Test-InstalledRuntimeEvidence/);
  assert.match(diagnostics, /function Get-RemainingVerifierBudgetMs/);
  assert.match(diagnostics, /verifier budget exhausted before \$Path request attempt \$attempt/);
  assert.match(diagnostics, /\$requestTimeoutSec = \[Math\]::Max\(1, \[Math\]::Min\(30, \[Math\]::Min\(\$TimeoutSec/);
  assert.match(diagnostics, /Start-Process -FilePath \$powerShellBin/);
  assert.match(diagnostics, /\$process\.WaitForExit\(\[Math\]::Max\(1000, \$remainingBudgetMs\)\)/);
  assert.match(diagnostics, /\$process\.Refresh\(\)/);
  assert.match(diagnostics, /\$payload\.ok -eq \$true/);
  assert.match(diagnostics, /failed with unknown exit code/);
  assert.match(diagnostics, /\$ScriptName timed out after/);
  assert.match(diagnostics, /ANTICODEX_DIAGNOSTICS_SCRIPT_ROOT/);
  assert.ok((diagnostics.match(/Test-ReleaseGateApprovalAndOfflineEvidence \$releaseGatesSummary/g) || []).length >= 2);
  assert.match(diagnostics, /reports summary file missing/);
  assert.match(diagnostics, /collect-anticodex-diagnostics\.ps1/);
  assert.match(diagnostics, /"-BaseUrl", \$BaseUrl, "-NoPopup"/);
  assert.match(collector, /antigravityCliProfilePrepareOk = \$json\.antigravityCliProfilePrepareOk/);
  assert.match(collector, /antigravityCliProfilePrepareContract = \$json\.antigravityCliProfilePrepareContract/);
  assert.match(collector, /antigravityCliWindowsUserLoginDryRunOk = \$json\.antigravityCliWindowsUserLoginDryRunOk/);
  assert.match(collector, /antigravityCliWindowsUserLoginDryRunContract = \$json\.antigravityCliWindowsUserLoginDryRunContract/);
  assert.match(collector, /publicDocumentationClientCopySyncContractOk = \$json\.publicDocumentationClientCopySyncContractOk/);
  assert.match(collector, /antigravityCliProfilePrepareEvidence = \$json\.antigravityCliProfilePrepareEvidence/);
  assert.match(collector, /secondAccountLoginEntrypointEvidence = \$json\.secondAccountLoginEntrypointEvidence/);
  assert.match(collector, /antigravityCliRealSmokeEvidence = \$json\.antigravityCliRealSmokeEvidence/);
  assert.match(diagnostics, /diagnostic real-smoke summary missing antigravityCliRealSmokeEvidence/);
  assert.match(diagnostics, /diagnostic real-smoke summary accountLaneRole mismatch/);
  assert.match(diagnostics, /diagnostic real-smoke summary claims MCP account lane is managed by Anti-Codex/);
  assert.match(diagnostics, /diagnostic real-smoke summary mcpAccountLaneOwner mismatch/);
  assert.match(diagnostics, /diagnostic real-smoke summary missing account identity comparison for separate account proof/);
  assert.match(diagnostics, /diagnostic real-smoke summary missing Anti-Codex account identity presence/);
  assert.match(diagnostics, /diagnostic real-smoke summary missing MCP account identity presence/);
  assert.match(diagnostics, /diagnostic real-smoke summary does not prove distinct account identities/);
  assert.match(diagnostics, /diagnostic real-smoke summary missing Anti-Codex identity source presence/);
  assert.match(diagnostics, /diagnostic real-smoke summary missing MCP identity source presence/);
  assert.match(diagnostics, /diagnostic real-smoke summary missing comparison method presence/);
  assert.match(diagnostics, /diagnostic real-smoke summary missing identity capture timestamp presence/);
  assert.match(diagnostics, /diagnostic real-smoke summary has account identity comparison without separate account proof/);
  assert.match(collector, /releaseBlockedOnlyByRequiredRealTraffic = \$json\.releaseBlockedOnlyByRequiredRealTraffic/);
  assert.match(collector, /requiredRealTrafficBlockedGates = @\(\$json\.requiredRealTrafficBlockedGates/);
  assert.match(diagnostics, /model-routing-refresh\.json/);
  assert.match(diagnostics, /latest-model-routing\.json/);
  assert.match(diagnostics, /modelRoutingEvidence/);
  assert.match(diagnostics, /diagnostic model-routing summary missing modelRoutingEvidence/);
  assert.match(diagnostics, /modelThinkingEvidence/);
  assert.match(diagnostics, /diagnostic model-thinking summary missing modelThinkingEvidence/);
  assert.match(diagnostics, /diagnostic model-thinking summary has missing budgets/);
  assert.match(diagnostics, /antigravityCliIsolation/);
  assert.match(diagnostics, /strictWindowsAppDataIsolation/);
  assert.match(diagnostics, /strict Antigravity CLI isolation missing APPDATA isolation/);
  assert.match(diagnostics, /Antigravity CLI isolation profileRoot missing Gemini dir/);
  assert.match(diagnostics, /toolBridgeEvidence/);
  assert.match(diagnostics, /diagnostic tool-bridge summary missing toolBridgeEvidence/);
  assert.match(diagnostics, /diagnostic tool-bridge summary missing request envelope/);
  assert.match(diagnostics, /diagnostic tool-bridge summary missing external tool definitions field/);
  assert.match(diagnostics, /diagnostic tool-bridge summary missing usable external tool definitions proof/);
  assert.match(diagnostics, /diagnostic tool-bridge summary missing schema-like request acceptance proof/);
  assert.match(diagnostics, /diagnostic tool-bridge summary missing native MCP tool call proof/);
  assert.match(diagnostics, /diagnostic tool-bridge summary missing same-Cascade resume proof/);
  assert.match(diagnostics, /uiIdleEvidence/);
  assert.match(diagnostics, /missing client sync mode/);
  assert.match(diagnostics, /missing client sync maintenance path/);
  assert.match(diagnostics, /missing no feature-rebuild flag/);
  assert.match(diagnostics, /wrong client sync mode/);
  assert.match(diagnostics, /does not reject feature-by-feature rebuild/);
  assert.match(diagnostics, /diagnostic ui-idle summary missing uiIdleEvidence/);
  assert.match(diagnostics, /diagnostic ui-idle summary has reconnect text/);
  assert.match(diagnostics, /syncReadinessEvidence/);
  assert.match(diagnostics, /diagnostic sync-readiness summary missing syncReadinessEvidence/);
  assert.match(diagnostics, /function Test-SyncReadinessEvidence/);
  assert.match(diagnostics, /missing source package version/);
  assert.match(diagnostics, /missing active source package version/);
  assert.match(diagnostics, /missing client sync version match flag/);
  assert.match(diagnostics, /client sync version mismatch/);
  assert.match(diagnostics, /missing required patch scope: \$RequiredPatch/);
  assert.match(diagnostics, /unexpected Anti-Codex patch scope/);
  assert.match(diagnostics, /Anti-Codex patch scope is not exact/);
  assert.match(diagnostics, /missing update status reason/);
  assert.match(diagnostics, /missing source host hash/);
  assert.match(diagnostics, /missing host hash match flag/);
  assert.match(diagnostics, /diagnostic sync-readiness summary manager bridge not ready/);
  assert.match(diagnostics, /sync-anticodex-launcher\.ps1/);
  assert.match(diagnostics, /installedOverallEvidence/);
  assert.match(diagnostics, /diagnostic installed-overall .* summary missing installedOverallEvidence/);
  assert.match(diagnostics, /diagnostic installed-overall .* summary missing real traffic skipped checks/);
  assert.match(diagnostics, /diagnostic installed-overall .* summary has Manager\/UI verifier busy lock evidence/);
  assert.match(diagnostics, /diagnostic installed-overall .* summary model text transport is not cli/);
  assert.match(diagnostics, /diagnostic installed-overall .* summary missing model discovery source/);
  assert.match(diagnostics, /diagnostic installed-overall .* summary model discovery source is not allowed/);
  assert.match(diagnostics, /AllowedAntigravityModelDiscoverySources/);
  assert.match(diagnostics, /diagnostic installed-overall .* summary antigravity coworker default is not false/);
  assert.match(diagnostics, /latest-post-verification\.json/);
  assert.match(diagnostics, /latest-source-preflight\.json/);
  assert.match(diagnostics, /latest-manager-real-buttons\.json/);
  assert.match(diagnostics, /latest-release-gates\.json/);
  assert.match(diagnostics, /release-gates summary/);
  assert.match(diagnostics, /shortReady/);
  assert.match(diagnostics, /releaseBlockedOnlyByRequiredRealTraffic/);
  assert.match(diagnostics, /\$releaseBlockedOnlyByRequiredRealTraffic = \(Has-Property \$releaseGatesSummary "releaseBlockedOnlyByRequiredRealTraffic"\)/);
  assert.match(diagnostics, /releaseReady -ne \$true -and -not \$releaseBlockedOnlyByRequiredRealTraffic/);
  assert.match(diagnostics, /effectiveOk -ne \$true -and -not \$releaseBlockedOnlyByRequiredRealTraffic/);
  assert.match(diagnostics, /requiredRealTrafficBlockedGates/);
  assert.match(diagnostics, /release-gates summary missing required real-traffic-only blocker flag/);
  assert.match(diagnostics, /release-gates real-traffic-only blocker gate \$blockedGateId has non-real-traffic or unblocked action/);
  assert.match(diagnostics, /release-gates summary releaseReady is not true/);
  assert.match(diagnostics, /release-gates summary missing effectiveOk/);
  assert.match(diagnostics, /release-gates summary effectiveOk is not true/);
  assert.match(diagnostics, /release-gates shortReady true with missing short gates/);
  assert.match(diagnostics, /release-gates releaseReady true with missing required gates/);
  assert.match(diagnostics, /release-gates effectiveOk true while releaseReady is not true/);
  assert.match(diagnostics, /release-gates effectiveOk true with damaged reports/);
  assert.match(diagnostics, /strictOptionalRealTraffic/);
  assert.match(diagnostics, /optionalRealTrafficReady/);
  assert.match(diagnostics, /optionalRealTrafficFailures/);
  assert.match(diagnostics, /release-gates optional real-traffic failure \$optionalFailureId missing guidance/);
  assert.match(diagnostics, /release-gates optional real-traffic ready has failures/);
  assert.match(diagnostics, /release-gates releaseReady true while strict optional real-traffic is not ready/);
  assert.match(diagnostics, /sourceSnapshotEvidence/);
  assert.match(diagnostics, /source snapshot evidence/);
  assert.match(diagnostics, /missingRequired/);
  assert.match(diagnostics, /missingShort/);
  assert.match(diagnostics, /missingOptional/);
  assert.match(diagnostics, /damagedReports/);
  assert.match(diagnostics, /releaseGateFailures/);
  assert.match(diagnostics, /plugin capability failure missing offline snapshot evidence/);
  assert.match(diagnostics, /plugin capability failure offline refresh gate is not satisfied/);
  assert.match(diagnostics, /plugin capability failure offline refresh selected file missing/);
  assert.match(diagnostics, /plugin capability failure offline source fingerprint missing/);
  assert.match(diagnostics, /plugin capability failure offline source file count missing/);
  assert.match(diagnostics, /plugin capability failure offline source mtime missing/);
  assert.match(diagnostics, /plugin capability failure missing sample codes/);
  assert.match(diagnostics, /release-gates failure \$gateFailureId missing sample codes/);
  assert.match(diagnostics, /release-gates failure \$gateFailureId missing failureReasons available count/);
  assert.match(diagnostics, /release-gates failure \$gateFailureId failureReasons hidden count mismatch/);
  assert.match(diagnostics, /release-gates failure \$semanticFailureId missing semanticFailures available count/);
  assert.match(diagnostics, /release-gates failure \$semanticFailureId semanticFailures hidden count mismatch/);
  assert.match(diagnostics, /release-gates failure \$semanticFailureId missing semantic failure reason marker/);
  assert.match(diagnostics, /release-gates failure \$failureId missing failure reason details/);
  assert.match(diagnostics, /release-gates damaged report \$damagedReportId missing failure reason details/);
  assert.match(diagnostics, /release-gates missing required gate \$missingGateId has no next action/);
  assert.match(diagnostics, /release-gates missing required gate \$missingGateId missing failure reason details/);
  assert.match(diagnostics, /release-gates missing required gate \$missingGateId missing guidance/);
  assert.match(diagnostics, /release-gates missing required gate \$missingGateId missing required-for-release marker/);
  assert.match(diagnostics, /release-gates missing short gate \$missingShortId missing failure reason details/);
  assert.match(diagnostics, /release-gates missing short gate \$missingShortId missing guidance/);
  assert.match(diagnostics, /release-gates missing short gate \$missingShortId missing required-for-short marker/);
  assert.match(diagnostics, /release-gates missing short gate \$missingShortId missing next action/);
  assert.match(diagnostics, /release-gates missing optional gate \$missingOptionalId missing failure reason details/);
  assert.match(diagnostics, /release-gates missing optional gate \$missingOptionalId missing guidance/);
  assert.match(diagnostics, /release-gates missing optional gate \$missingOptionalId missing optional marker/);
  assert.match(diagnostics, /release-gates summary missing release gate group evidence/);
  assert.match(diagnostics, /selectedFromHistory -eq \$true/);
  assert.match(diagnostics, /historySourceMismatch -eq \$true/);
  assert.match(diagnostics, /missing history source mismatch detail/);
  assert.match(diagnostics, /\$syncReadinessReason/);
  assert.match(diagnostics, /release-gates selected history gate \$selectedGateId missing selected report detail/);
  assert.match(diagnostics, /release-gates selected history gate \$selectedGateId missing selected report mtime/);
  assert.match(diagnostics, /release-gates group \$groupName missing required gate \$groupMissingRequiredId absent from top-level missingRequired/);
  assert.match(diagnostics, /release-gates group \$groupName missing required gate \$groupMissingRequiredId has no next action/);
  assert.match(diagnostics, /release-gates group \$groupName missing optional gate \$groupMissingOptionalId absent from top-level missingOptional/);
  assert.match(diagnostics, /release-gates group \$groupName missing total count/);
  assert.match(diagnostics, /release-gates group \$groupName total count mismatch/);
  assert.match(diagnostics, /release-gates group \$groupName satisfied count exceeds total/);
  assert.match(diagnostics, /release-gates next action \$actionId missing command/);
  assert.match(diagnostics, /release-gates ordered action \$gateFailureId\/\$actionId command requires real-traffic metadata/);
  assert.match(diagnostics, /release-gates failure \$gateFailureId with ordered actions missing guidance/);
  assert.match(diagnostics, /release-gates ordered action \$gateFailureId\/\$actionId missing guidance/);
  assert.match(diagnostics, /release-gates ordered action \$gateFailureId\/\$actionId missing reason/);
  assert.match(diagnostics, /release-gates next action \$actionId missing guidance/);
  assert.match(diagnostics, /release-gates next action \$actionId missing reason/);
  assert.match(diagnostics, /nextActions/);
  assert.match(diagnostics, /release-gates summary missing ordered next actions/);
  assert.match(diagnostics, /release-gates summary missing nextActions available count/);
  assert.match(diagnostics, /release-gates summary nextActions hidden count mismatch/);
  assert.match(diagnostics, /release-gates summary nextActions truncated flag mismatch/);
  assert.match(diagnostics, /release-gates approval plan is not an object/);
  assert.match(diagnostics, /release-gates approval plan invalid real-traffic count/);
  assert.match(diagnostics, /release-gates approval plan missing report-only count/);
  assert.match(diagnostics, /release-gates approval plan invalid report-only count/);
  assert.match(diagnostics, /release-gates approval plan undercounts report-only actions/);
  assert.match(diagnostics, /release-gates approval plan missing required-for-short count/);
  assert.match(diagnostics, /release-gates approval plan undercounts required-for-short actions/);
  assert.match(diagnostics, /release-gates approval plan overcounts required-for-short actions/);
  assert.match(diagnostics, /release-gates approval plan missing required-for-release count/);
  assert.match(diagnostics, /release-gates approval plan undercounts required-for-release actions/);
  assert.match(diagnostics, /release-gates approval plan overcounts required-for-release actions/);
  assert.match(diagnostics, /release-gates approval plan report-only action count mismatch/);
  assert.match(diagnostics, /release-gates approval plan report-only phase mismatch/);
  assert.match(diagnostics, /release-gates approval plan overcounts gateway actions/);
  assert.match(diagnostics, /release-gates approval plan phase \$phaseName count mismatch/);
  assert.match(diagnostics, /release-gates approval plan phase \$phaseName real-traffic mismatch/);
  assert.match(diagnostics, /release-gates real-traffic-only blocker approval plan points at gateway start/);
  assert.match(diagnostics, /release-gates real-traffic-only blocker approval plan first action is not a required real-traffic gate/);
  assert.match(diagnostics, /release-gates semantic failures missing report-only next action/);
  assert.match(diagnostics, /nextActions = @\(\$releaseGatesSummary\.nextActions\)/);
  assert.match(diagnostics, /installedRuntimeEvidence/);
  assert.match(diagnostics, /release-gates summary missing installed runtime drift evidence/);
  assert.match(diagnostics, /release-gates summary reports installed runtime satisfied without \$driftField evidence/);
  assert.match(diagnostics, /release-gates summary reports installed runtime satisfied with \$driftField drift/);
  assert.match(diagnostics, /installedRuntimeEvidence = \$releaseGatesSummary\.installedRuntimeEvidence/);
  assert.match(diagnostics, /approvalPlan = \$releaseGatesSummary\.approvalPlan/);
  assert.match(diagnostics, /installed runtime source fingerprint/);
  assert.match(diagnostics, /latest-third-party-provider\.json/);
  assert.match(diagnostics, /third-party provider summary/);
  assert.match(diagnostics, /providerContinuity/);
  assert.match(diagnostics, /crossProtocolWithoutHistoryLoss/);
  assert.match(diagnostics, /structuralEvidenceClean/);
  assert.match(diagnostics, /orderedHistoryClean/);
  assert.match(diagnostics, /previousResponseContinuity/);
  assert.match(diagnostics, /previousResponseIdChain/);
  assert.match(diagnostics, /previous_response_id chain values/);
  assert.match(diagnostics, /provider-switch previous_response_id continuity/);
  assert.match(diagnostics, /save previous_response_id mismatch/);
  assert.match(diagnostics, /restart previous_response_id mismatch/);
  assert.match(diagnostics, /third-party provider summary missing ordered role history evidence/);
  assert.match(diagnostics, /sixthOrderedHistoryCount/);
  assert.match(diagnostics, /seventhOrderedHistoryCount/);
  assert.match(diagnostics, /eighthOrderedHistoryCount/);
  assert.match(diagnostics, /ninthOrderedHistoryCount/);
  assert.match(diagnostics, /sixthAfterRestartAllHistoryMarkerCount/);
  assert.match(diagnostics, /seventhAfterProviderSwitchAllHistoryMarkerCount/);
  assert.match(diagnostics, /eighthAfterProtocolSwitchAllHistoryMarkerCount/);
  assert.match(diagnostics, /ninthAfterReverseProtocolSwitchAllHistoryMarkerCount/);
  assert.match(diagnostics, /reverseCrossProtocolWithoutHistoryLoss/);
  assert.match(diagnostics, /secretsRedacted/);
  assert.match(diagnostics, /manager-real-buttons summary/);
  assert.match(diagnostics, /managerButtonOk/);
  assert.match(diagnostics, /managerButtonResults/);
  assert.match(diagnostics, /mcpSkills/);
  assert.match(diagnostics, /MCP\/Skill summary has changed shared skills/);
  assert.match(diagnostics, /pluginCapabilities/);
  assert.match(diagnostics, /latest-local-connectors\.json/);
  assert.match(diagnostics, /latest-plugin-capabilities\.json/);
  assert.match(diagnostics, /local connector summary/);
  assert.match(diagnostics, /local connector summary missing reportName/);
  assert.match(diagnostics, /local connector summary used real traffic/);
  assert.match(diagnostics, /local connector summary behavior not covered/);
  assert.match(diagnostics, /local connector summary coverageKind mismatch/);
  assert.match(diagnostics, /local connector summary GET\/POST tool counts differ/);
  assert.match(diagnostics, /local connector summary missing connector parity proof/);
  assert.match(diagnostics, /local connector summary missing app-tool parity proof/);
  assert.match(diagnostics, /local connector summary missing GET\/POST app-tool parity proof/);
  assert.match(diagnostics, /local connector summary missing connector missing-shared drift samples/);
  assert.match(diagnostics, /local connector summary missing app-tool changed-shared drift samples/);
  assert.match(diagnostics, /local connector summary exposed tool names is not exactly one 'linked_tool'/);
  assert.match(diagnostics, /plugin capability summary/);
  assert.match(diagnostics, /plugin capability summary is short-budget and not release-grade/);
  assert.match(diagnostics, /plugin capability summary is degraded by short budget/);
  assert.match(diagnostics, /localConnectorEvidence/);
  assert.match(diagnostics, /mcpSkillEvidence/);
  assert.match(diagnostics, /pluginCapabilityEvidence/);
  assert.match(diagnostics, /optionalRealProviderEvidence/);
  assert.match(diagnostics, /antigravityReturnEvidence/);
  assert.match(diagnostics, /connectorParityMissingShared/);
  assert.match(diagnostics, /appToolGetPostMissingFromGet/);
  assert.match(diagnostics, /appToolRegistryContentMatches/);
  assert.match(diagnostics, /appToolRegistryFingerprintMatches/);
  assert.match(diagnostics, /mcpRealListCount/);
  assert.match(diagnostics, /MCP\/Skill summary missing MCP real tools\/list count evidence/);
  assert.match(diagnostics, /\$RequiredWorkerMcpServers = @\(/);
  assert.match(diagnostics, /MCP\/Skill summary missing worker MCP real tools\/list evidence/);
  assert.doesNotMatch(diagnostics, /mcpRealListPassed -lt 2/);
  assert.match(diagnostics, /MCP\/Skill short-budget summary missing reused source snapshot proof/);
  assert.match(diagnostics, /MCP\/Skill short-budget summary missing skill fingerprint skipped proof/);
  assert.match(diagnostics, /MCP\/Skill summary app-tool registry content mismatch/);
  assert.match(diagnostics, /MCP\/Skill summary app-tool registry missing shared file count/);
  assert.match(diagnostics, /MCP\/Skill summary missing mcpSkillEvidence/);
  assert.match(diagnostics, /MCP\/Skill summary has extra local MCP entries/);
  assert.match(diagnostics, /MCP\/Skill summary has changed shared MCP entries/);
  assert.match(diagnostics, /MCP\/Skill summary has extra local skills/);
  assert.match(diagnostics, /MCP\/Skill summary has conflicting duplicate skills/);
  assert.match(diagnostics, /refreshFeatureEvidence/);
  assert.match(diagnostics, /refresh-features summary missing elapsedMs evidence/);
  assert.match(diagnostics, /changedExpectedSkills/);
  assert.match(diagnostics, /guidanceChanged/);
  assert.match(diagnostics, /recoveryActions/);
  assert.match(diagnostics, /recoveryActionIds/);
  assert.match(diagnostics, /refresh-features recovery action missing id/);
  assert.match(diagnostics, /refresh-features recovery action missing guidance/);
  assert.match(diagnostics, /refresh-features recovery action missing command guidance/);
  assert.match(diagnostics, /refresh-features recovery action unexpectedly requires real traffic/);
  assert.match(diagnostics, /refresh-features summary missing refreshFeatureEvidence/);
  assert.match(diagnostics, /refresh-features summary connector parity not clean/);
  assert.match(diagnostics, /refresh-features summary app-tool parity not clean/);
  assert.match(diagnostics, /refresh-features summary skill content parity not clean/);
  assert.match(diagnostics, /refresh-features summary guidance parity not clean/);
  assert.match(diagnostics, /refreshFeatures = if \(\$refreshFeaturesSummary\)/);
  assert.match(diagnostics, /optional real-provider summary missing continuity evidence/);
  assert.match(diagnostics, /optional real-provider summary reportName mismatch/);
  assert.match(diagnostics, /optional real-provider skipped summary requested real traffic/);
  assert.match(diagnostics, /optional real-provider skipped summary coverage kind mismatch/);
  assert.match(diagnostics, /Antigravity return summary missing continuity evidence/);
  assert.match(diagnostics, /Antigravity return summary reportName mismatch/);
  assert.match(diagnostics, /Antigravity return skipped summary requested real traffic/);
  assert.match(diagnostics, /Antigravity return skipped summary coverage kind mismatch/);
  assert.match(diagnostics, /mcpSkills = if \(\$mcpSkillsSummary\)/);
  assert.match(diagnostics, /pluginCapabilities = if \(\$pluginCapabilitiesSummary\)/);
  assert.match(diagnostics, /evidence = \$pluginCapabilitiesSummary\.pluginCapabilityEvidence/);
  assert.match(diagnostics, /sourceSnapshot = \$pluginCapabilitiesSummary\.sourceSnapshotEvidence/);
  assert.match(diagnostics, /optionalRealProvider = if \(\$optionalRealProviderSummary\)/);
  assert.match(diagnostics, /antigravityReturn = if \(\$antigravityReturnSummary\)/);
  assert.match(diagnostics, /upstreamRequestsDuringLocalEndpoints/);
  assert.match(diagnostics, /exposedToolsPost/);
  assert.match(diagnostics, /exposedToolsGet/);
  assert.match(diagnostics, /unauthorizedAppToolCount/);
  assert.match(diagnostics, /connectorParityExtraLocal/);
  assert.match(diagnostics, /connectorParityChangedShared/);
  assert.match(diagnostics, /appToolParityMissingShared/);
  assert.match(diagnostics, /appToolParityExtraLocal/);
  assert.match(diagnostics, /appToolParityChangedShared/);
  assert.match(diagnostics, /appToolGetPostExtraFromGet/);
  assert.match(diagnostics, /appToolGetPostParityContentMatches/);
  assert.match(diagnostics, /plugin capability summary missing GET\/POST content match proof/);
  assert.match(diagnostics, /lastUiOnly/);
  assert.match(diagnostics, /manager-real-buttons action missing bridge ready evidence/);
  assert.match(diagnostics, /manager-real-buttons action missing overlay evidence/);
  assert.match(diagnostics, /manager-real-buttons action center did not hit button/);
  assert.match(diagnostics, /manager-real-buttons action close hit area failed/);
  assert.match(diagnostics, /manager-real-buttons action opened a new page/);
  assert.match(diagnostics, /manager-real-buttons action missing page target counts/);
  assert.match(diagnostics, /manager-real-buttons action increased page target count/);
  assert.match(diagnostics, /shortcutRepair/);
  assert.match(diagnostics, /sourcePreflight/);
  assert.match(diagnostics, /logDbGuard/);
  assert.match(diagnostics, /diagnostics missing log database guard status/);
  assert.match(diagnostics, /diagnostics log database guard is not protected/);
  assert.match(diagnostics, /diagnostic log database guard summary invalid wal size/);
  assert.match(diagnostics, /source preflight status/);
  assert.match(diagnostics, /source-preflight summary/);
  assert.match(diagnostics, /source-preflight summary missing noTraffic/);
  assert.match(diagnostics, /source-preflight summary used real traffic/);
  assert.match(diagnostics, /source-preflight summary behavior not covered/);
  assert.match(diagnostics, /source-preflight summary coverageKind mismatch/);
  assert.match(diagnostics, /javascriptSyntaxOk/);
  assert.match(diagnostics, /powershellSyntaxOk/);
  assert.match(diagnostics, /uiStateSelfTestOk/);
  assert.match(diagnostics, /upstreamProfileStorageOk/);
  assert.match(diagnostics, /antigravityCliIsolationProfileOk/);
  assert.match(diagnostics, /antigravityCliIsolationProfileContract/);
  assert.match(diagnostics, /source-preflight summary missing Antigravity CLI isolation profile contract/);
  assert.match(diagnostics, /source-preflight summary isolation profile claims separate account verified/);
  assert.match(diagnostics, /diagnostics source preflight missing Antigravity CLI isolation profile contract/);
  assert.match(diagnostics, /diagnostics source preflight isolation profile claims separate account verified/);
  assert.match(diagnostics, /antigravityCliProfilePrepareOk/);
  assert.match(diagnostics, /antigravityCliProfilePrepareContract/);
  assert.match(diagnostics, /antigravityCliWindowsUserLoginDryRunOk/);
  assert.match(diagnostics, /antigravityCliWindowsUserLoginDryRunContract/);
  assert.match(diagnostics, /Windows-user login dry-run targets current user/);
  assert.match(diagnostics, /Windows-user login dry-run missing readiness blocking reason/);
  assert.match(diagnostics, /source-preflight summary missing Antigravity CLI profile prepare contract/);
  assert.match(diagnostics, /source-preflight summary profile prepare claims separate account verified/);
  assert.match(diagnostics, /diagnostics source preflight missing Antigravity CLI profile prepare contract/);
  assert.match(diagnostics, /antigravityCliProfilePrepareRejectsDefaultChildOk/);
  assert.match(diagnostics, /default-child rejection/);
  assert.match(diagnostics, /diagnostics source preflight profile prepare claims separate account verified/);
  // Diagnostics reports-summary path must cover the independent latest-antigravity-cli-profile-prepare.json no-traffic caveat
  assert.match(diagnostics, /antigravityCliProfilePrepareEvidence/);
  assert.match(diagnostics, /latest-antigravity-cli-profile-prepare\.json/);
  assert.match(diagnostics, /separateAccountVerified/);
  assert.match(diagnostics, /accountIsolationCaveat/);
  assert.match(diagnostics, /profile prepare is not real dual-account proof/);
  assert.match(diagnostics, /localConnectorVerifierOk/);
  assert.match(diagnostics, /publicDocumentationOk/);
  assert.match(diagnostics, /publicDocumentationClientCopySyncContractOk/);
  assert.match(diagnostics, /source-preflight summary missing client-copy public documentation contract success/);
  assert.match(diagnostics, /translatorRegressionOk/);
  assert.match(diagnostics, /diffWhitespaceOk/);
  assert.match(diagnostics, /skipFullRegression/);
  assert.match(diagnostics, /translator-lifecycle\.json/);
  assert.match(diagnostics, /translator-lifecycle\.jsonl/);
  assert.match(diagnostics, /postVerification/);
  assert.match(diagnostics, /lifecycleLogs/);
  assert.match(diagnostics, /latestDiagnosisDetail/);
  assert.match(diagnostics, /accountProxyEvidence/);
  assert.match(diagnostics, /account-proxy summary missing diagnosisDetail/);
  assert.match(diagnostics, /account-proxy summary missing suggestedAction/);
  assert.match(diagnostics, /account-proxy summary missing localProxyBypassed/);
  assert.match(diagnostics, /account-proxy summary missing phaseSummary/);
  assert.match(diagnostics, /account-proxy summary missing antigravityLogSignals/);
  assert.match(diagnostics, /account-proxy summary exposes an account fingerprint/);
  assert.match(diagnostics, /longTasks/);
  assert.match(diagnostics, /diagnostics-summary\.json/);
  assert.match(diagnostics, /\$diagnosticsSummaryPath/);
  assert.match(diagnostics, /diagnostic bundle missing diagnostics-summary\.json/);
  assert.match(diagnostics, /diagnostic summary missing longTasks/);
  assert.match(diagnostics, /otherRunningItems/);
  assert.match(diagnostics, /foreach \(\$expectedTask in @\("syncHost", "postVerificationFull"\)\)/);
  assert.doesNotMatch(diagnostics, /longTaskItems\.Count\s+-eq\s+2/);
  assert.match(diagnostics, /Select-Object -First 1\)\[0\]/);
  assert.match(diagnostics, /latestLogLine/);
  assert.match(diagnostics, /logUpdatedAt/);
  assert.match(diagnostics, /logAgeMs/);
  assert.match(diagnostics, /lifecycle/);
  assert.match(diagnostics, /translator lifecycle status/);
  assert.match(diagnostics, /skipRequests/);
  assert.match(diagnostics, /antigravity-desktop/);
  assert.match(diagnostics, /\$diagnosticMode = "unknown"/);
  assert.match(diagnostics, /\$diagnosticMode -eq "third-party"/);
  assert.match(diagnostics, /third-party diagnostics missing protocol/);
  assert.match(diagnostics, /third-party diagnostics missing model/);
  assert.match(diagnostics, /diagnostics model text transport is not cli/);
  assert.match(diagnostics, /diagnostics missing model discovery source/);
  assert.match(diagnostics, /diagnostics model discovery source is not allowed/);
  assert.match(diagnostics, /diagnostics antigravity coworker default is not false/);
  assert.match(diagnostics, /provider-native-or-compat/);
  assert.match(diagnostics, /upstream-provider/);
  assert.match(diagnostics, /mode = \$diagnosticMode/);
  assert.match(diagnostics, /third-party diagnostic bundle treats Antigravity reports as optional/);
  assert.match(diagnostics, /codexHome/);
  assert.match(diagnostics, /sharedCodexHome/);
  assert.match(diagnostics, /should be isolated from sharedCodexHome/);
  assert.match(diagnostics, /modelRouteAudit/);
  assert.match(diagnostics, /toolBridge\.mode/);
  assert.match(diagnostics, /native Antigravity tool events/i);
  assert.match(diagnostics, /localFeatures/);
  assert.match(diagnostics, /local Skill\/MCP feature summary/);
  assert.match(diagnostics, /localFeatures\.skills/);
  assert.match(diagnostics, /required skill:/);
  assert.match(diagnostics, /headroom/);
  assert.match(diagnostics, /context-save/);
  assert.match(diagnostics, /context-restore/);
  assert.match(diagnostics, /keep-codex-fast/);
  assert.match(diagnostics, /sample/);
  assert.match(diagnostics, /localFeatures\.mcp/);
  assert.match(diagnostics, /configPath/);
  assert.match(diagnostics, /node_repl/);
  assert.match(diagnostics, /connectorDirectoryFiles/);
  assert.match(diagnostics, /appToolsCacheFiles/);
  assert.match(diagnostics, /snapshotStatus/);
  assert.match(diagnostics, /sourceFingerprintComparable/);
  assert.match(diagnostics, /sourceFingerprintMatches/);
  assert.match(diagnostics, /staleReason/);
  assert.match(diagnostics, /tools\.bridge/);
  assert.match(diagnostics, /native_mcp_same_cascade/);
  assert.match(diagnostics, /automatic native permission handling/);
  assert.match(diagnostics, /accountTracking/);
  assert.match(diagnostics, /exposes an account fingerprint/);
  assert.match(diagnostics, /antigravityQueue/);
  assert.match(diagnostics, /antigravitySessionLock/);
  assert.match(diagnostics, /maxQueued/);
  assert.match(diagnostics, /exceeds its configured limit/);
  assert.match(diagnostics, /tool output\|messages\|input_items\|Return exactly this/);
  assert.doesNotMatch(diagnostics, /Stop-Process|auth\/login/);
  assert.match(collector, /noTraffic = \$json\.noTraffic/);
});

function minimalDiagnosticsReleaseGateSummary(overrides = {}) {
  const installedRuntimeEvidence = {
    satisfied: true,
    sourceFileCount: 2,
    installedRuntimeFileCount: 2,
    sourceFingerprint: "abc123",
    installedRuntimeFingerprint: "abc123",
    missingSourceFiles: [],
    missingInstalledRuntimeFiles: [],
    mismatchedRuntimeFiles: [],
    ...(overrides.installedRuntimeEvidence || {}),
  };
  return {
    file: "latest-release-gates.json",
    ok: false,
    shortReady: false,
    releaseReady: false,
    effectiveOk: false,
    strictOptionalRealTraffic: false,
    optionalRealTrafficReady: false,
    optionalRealTrafficFailures: [],
    missingRequired: [],
    missingShort: [],
    missingOptional: [],
    damagedReports: [],
    releaseGateFailures: [],
    releaseGateFailureReasons: [],
    nextActions: [],
    nextActionsAvailableCount: 0,
    nextActionsHiddenCount: 0,
    nextActionsTruncated: false,
    approvalPlan: {
      actionCount: 0,
      blockedCount: 0,
      requiresGatewayStartCount: 0,
      requiresRealTrafficCount: 0,
      highImpactCount: 0,
      reportOnlyCount: 0,
      requiredForShortCount: 0,
      requiredForReleaseCount: 0,
      phases: [],
    },
    releaseGateGroups: [],
    releaseGateSelectedReports: [{ id: "syncReadiness", selectedFile: "20260624-sync-readiness.json" }],
    ...overrides,
    installedRuntimeEvidence,
  };
}

test("diagnostics verifier bounds a silent diagnostics endpoint", async () => {
  const server = http.createServer(() => {
    // Intentionally keep the request open until the verifier-side timeout fires.
  });
  await new Promise((resolveServer, rejectServer) => {
    server.once("error", rejectServer);
    server.listen(0, "127.0.0.1", resolveServer);
  });
  try {
    const port = server.address().port;
    const startedAt = Date.now();
    const result = spawnSync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy", "Bypass",
      "-File", resolve(root, "scripts", "test-anticodex-diagnostics.ps1"),
      "-TimeoutSec", "5",
      "-BaseUrl", `http://127.0.0.1:${port}`,
    ], { encoding: "utf8", timeout: 12000 });
    const elapsedMs = Date.now() - startedAt;
    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.ok(elapsedMs < 10000, `diagnostics verifier took ${elapsedMs}ms`);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, false);
    assert.ok(payload.failures.some((failure) => failure.includes("diagnostics request failed")));
    assert.equal(payload.diagnostics, null);
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
});

test("diagnostics bundle verification bounds a slow collector child", async () => {
  const tempRoot = mkdtempSync(join(os.tmpdir(), "anticodex-diagnostics-child-budget-"));
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({
      ok: true,
      object: "anticodex.diagnostics",
      health: { upstream: "antigravity-desktop", modelCount: 1, accountReady: true },
      mode: { upstream: "antigravity-desktop" },
      reports: { summaries: [] },
    }));
  });
  await new Promise((resolveServer, rejectServer) => {
    server.once("error", rejectServer);
    server.listen(0, "127.0.0.1", resolveServer);
  });
  try {
    const port = server.address().port;
    writeFileSync(join(tempRoot, "collect-anticodex-diagnostics.ps1"), [
      "param([string]$BaseUrl = '', [switch]$NoPopup)",
      "Start-Sleep -Seconds 20",
      "'{\"ok\":true,\"zipPath\":\"fake.zip\",\"bundleRoot\":\"fake\"}'",
    ].join("\n"), "utf8");
    const startedAt = Date.now();
    const result = spawnSync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy", "Bypass",
      "-File", resolve(root, "scripts", "test-anticodex-diagnostics.ps1"),
      "-VerifyBundle",
      "-TimeoutSec", "14",
      "-BaseUrl", `http://127.0.0.1:${port}`,
    ], {
      encoding: "utf8",
      timeout: 22000,
      cwd: tempRoot,
      env: { ...process.env, ANTICODEX_DIAGNOSTICS_SCRIPT_ROOT: tempRoot },
    });
    const elapsedMs = Date.now() - startedAt;
    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.ok(elapsedMs < 21000, `diagnostics child verifier took ${elapsedMs}ms`);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, false);
    assert.ok(payload.failures.some((failure) => failure.includes("collect-anticodex-diagnostics.ps1")
      && (failure.includes("timed out") || failure.includes("skipped because verifier budget was exhausted"))));
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("diagnostics verifier validates reports-summary fixtures without contacting the gateway", () => {
  const tempRoot = mkdtempSync(join(os.tmpdir(), "anticodex-diagnostics-summary-"));
  try {
    const summaryPath = join(tempRoot, "reports-summary.json");
    writeFileSync(summaryPath, JSON.stringify([{
      file: "latest-release-gates.json",
      ok: false,
      shortReady: false,
      releaseReady: false,
      effectiveOk: false,
      releaseBlockedOnlyByRequiredRealTraffic: false,
      requiredRealTrafficBlockedGates: [],
      strictOptionalRealTraffic: false,
      optionalRealTrafficReady: false,
      optionalRealTrafficFailures: [],
      missingRequired: ["pluginCapabilities"],
      missingShort: ["pluginCapabilities"],
      missingOptional: ["coldRelaunch"],
      releaseGateGroups: [{
        group: "short",
        total: 1,
        satisfied: 0,
        required: 1,
        requiredSatisfied: 0,
        optional: 0,
        optionalSatisfied: 0,
        missingRequired: ["pluginCapabilities"],
        missingOptional: [],
      }],
      damagedReports: [],
      releaseGateFailures: ["pluginCapabilities"],
      releaseGateFailureReasons: [{
        id: "pluginCapabilities",
        requiredForShort: true,
        requiredForRelease: true,
        guidance: "local_gateway_offline: start or restore the local Anti-Codex gateway, then rerun plugin/app capability check.",
        reportFailureSamples: ["health request failed"],
        reportFailureSampleCodes: ["local_gateway_offline"],
        offlineSnapshotEvidence: {
          connectorContentMatches: true,
          appToolContentMatches: true,
          refreshGateSatisfied: true,
          refreshSelectedFile: "latest-refresh-features.json",
          sourceFingerprint: "abc123",
          sourceFileCount: 2,
          sourceMtimeMax: "2026-06-24T00:00:00.000Z",
        },
      }, {
        id: "coldRelaunch",
        requiredForShort: false,
        requiredForRelease: false,
        failureReasons: ["missing_report"],
        failureReasonsAvailableCount: 1,
        failureReasonsHiddenCount: 0,
        guidance: "optional_cold_relaunch_required: optional cold-relaunch evidence is missing or stale; run only with explicit user approval because it restarts the isolated Anti-Codex runtime.",
        orderedActions: [],
      }],
      nextActions: [{
        id: "pluginCapabilities",
        command: "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\test-anticodex-plugin-capabilities.ps1 -TimeoutSec 45",
        reason: "ok_false",
        guidance: "local_gateway_offline: start or restore the local Anti-Codex gateway, then rerun plugin/app capability check.",
        requiresGatewayStart: true,
        requiresRealTraffic: false,
        highImpact: false,
        requiredForShort: true,
        requiredForRelease: true,
        blockedUntilExplicitUserApproval: true,
      }],
      nextActionsAvailableCount: 1,
      nextActionsHiddenCount: 0,
      nextActionsTruncated: false,
      approvalPlan: {
        actionCount: 1,
        blockedCount: 1,
        requiresGatewayStartCount: 1,
        requiresRealTrafficCount: 0,
        highImpactCount: 0,
        reportOnlyCount: 0,
        requiredForShortCount: 1,
        requiredForReleaseCount: 1,
        firstBlockedAction: "pluginCapabilities",
      },
      releaseGateSelectedReports: [{ id: "syncReadiness", selectedFile: "20260624-sync-readiness.json" }],
      installedRuntimeEvidence: {
        satisfied: true,
        sourceFileCount: 2,
        installedRuntimeFileCount: 2,
        sourceFingerprint: "abc123",
        installedRuntimeFingerprint: "abc123",
        missingSourceFiles: [],
        missingInstalledRuntimeFiles: [],
        mismatchedRuntimeFiles: [],
      },
    }, {
      file: "latest-sync-readiness.json",
      ok: false,
      syncReadinessEvidence: {
        clientSyncMode: "codex-client-copy-plus-anticodex-patches",
        clientSyncMaintenancePath: "guarded-host-sync-then-reapply-anticodex-patches",
        nativeClientBehaviorCarriedByHostSync: true,
        forbidsFeatureByFeatureReimplementation: true,
        sourcePackageName: "OpenAI.Codex",
        activeSourcePackageName: "OpenAI.Codex",
        clientSyncHostHashMatches: false,
        clientSyncCliHashMatches: false,
        antiCodexPatchScope: ["branding", "icons", "shortcuts", "isolation", "launcher", "model-adapter"],
        sourcePackageVersion: "26.623.3245.0",
        activeSourcePackageVersion: "26.623.3245.0",
        clientSyncVersionMatches: true,
        activePackageVersion: "26.616.9593.0",
        updateStatusReason: "source_codex_changed",
        sourceHostHash: "SOURCEHOST",
        activeHostHash: "ACTIVEHOST",
        sourceCliHash: "SOURCECLI",
        activeCliHash: "ACTIVECLI",
        hostHashMatches: false,
        cliHashMatches: false,
      },
    }]), "utf8");

    const result = spawnSync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      resolve(root, "scripts", "test-anticodex-diagnostics.ps1"),
      "-VerifyReportsSummary",
      summaryPath,
    ], { encoding: "utf8", windowsHide: true, timeout: 15000 });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.baseUrl, "");
    assert.equal(payload.diagnostics, null);
    assert.equal(payload.reportsSummary.releaseGates.missingRequired[0], "pluginCapabilities");
    assert.equal(payload.reportsSummary.releaseGates.releaseGateGroups[0].missingRequired[0], "pluginCapabilities");
    assert.equal(payload.reportsSummary.releaseGates.nextActions.length, 1);
    assert.equal(payload.reportsSummary.releaseGates.nextActionsAvailableCount, 1);
    assert.equal(payload.reportsSummary.releaseGates.nextActionsHiddenCount, 0);
    assert.equal(payload.reportsSummary.releaseGates.nextActionsTruncated, false);
    assert.equal(payload.reportsSummary.releaseGates.approvalPlan.reportOnlyCount, 0);
    assert.equal(payload.reportsSummary.releaseGates.installedRuntimeEvidence.satisfied, true);
    assert.equal(payload.reportsSummary.syncReadiness.evidence.sourcePackageVersion, "26.623.3245.0");
    assert.equal(payload.reportsSummary.syncReadiness.evidence.activeSourcePackageVersion, "26.623.3245.0");
    assert.equal(payload.reportsSummary.syncReadiness.evidence.clientSyncVersionMatches, true);
    assert.equal(payload.reportsSummary.syncReadiness.evidence.activePackageVersion, "26.616.9593.0");
    assert.equal(payload.reportsSummary.syncReadiness.evidence.hostHashMatches, false);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("diagnostics reports-summary fixture rejects malformed refresh recovery actions even when refresh failed", () => {
  const tempRoot = mkdtempSync(join(os.tmpdir(), "anticodex-diagnostics-refresh-recovery-failed-"));
  try {
    const summaryPath = join(tempRoot, "reports-summary.json");
    writeFileSync(summaryPath, JSON.stringify([
      minimalDiagnosticsReleaseGateSummary(),
      {
        file: "latest-refresh-features.json",
        ok: false,
        sourceSnapshotEvidence: {
          fingerprint: "source-refresh-fingerprint",
          fileCount: 3,
          sourceMtimeMax: "2026-06-29T00:00:00.000Z",
        },
        refreshFeatureEvidence: {
          recoveryActions: [{
            id: "refreshFeatures.skillsDirectoryLocked",
            guidance: "",
            commands: ["powershell.exe -File scripts/refresh-anticodex-local-features.ps1 -VerifyOnly"],
            requiresRealTraffic: false,
          }],
          recoveryActionIds: ["refreshFeatures.skillsDirectoryLocked"],
        },
      },
    ]), "utf8");

    const result = spawnSync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      resolve(root, "scripts", "test-anticodex-diagnostics.ps1"),
      "-VerifyReportsSummary",
      summaryPath,
    ], { encoding: "utf8", windowsHide: true, timeout: 15000 });
    assert.equal(result.status, 1, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, false);
    assert.ok(payload.failures.includes("refresh-features recovery action missing guidance"));
    assert.equal(payload.diagnostics, null);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("diagnostics reports-summary fixture rejects failure truncation count mismatches", () => {
  const tempRoot = mkdtempSync(join(os.tmpdir(), "anticodex-diagnostics-failure-counts-"));
  try {
    const summaryPath = join(tempRoot, "reports-summary.json");
    writeFileSync(summaryPath, JSON.stringify([minimalDiagnosticsReleaseGateSummary({
      releaseGateFailures: [{
        id: "postVerification",
        semanticFailures: ["post_verification_not_release_ready", "post_verification_failed_checks"],
        semanticFailuresAvailableCount: 4,
        semanticFailuresHiddenCount: 0,
      }],
      releaseGateFailureReasons: [{
        id: "postVerification",
        failureReasons: ["stale_report", "semantic_failures"],
        failureReasonsAvailableCount: 2,
        failureReasonsHiddenCount: 3,
        guidance: "real_traffic_evidence_stale: requires explicit user approval.",
        orderedActions: [],
      }],
    })]), "utf8");

    const result = spawnSync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      resolve(root, "scripts", "test-anticodex-diagnostics.ps1"),
      "-VerifyReportsSummary",
      summaryPath,
    ], { encoding: "utf8", windowsHide: true, timeout: 15000 });
    assert.equal(result.status, 1, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, false);
    assert.ok(payload.failures.includes("release-gates failure postVerification failureReasons hidden count mismatch"));
    assert.ok(payload.failures.includes("release-gates failure postVerification semanticFailures hidden count mismatch"));
    assert.equal(payload.diagnostics, null);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("diagnostics reports-summary fixture rejects missing release-gate group evidence", () => {
  const tempRoot = mkdtempSync(join(os.tmpdir(), "anticodex-diagnostics-groups-required-"));
  try {
    const summaryPath = join(tempRoot, "reports-summary.json");
    const releaseGates = minimalDiagnosticsReleaseGateSummary();
    delete releaseGates.releaseGateGroups;
    writeFileSync(summaryPath, JSON.stringify([releaseGates]), "utf8");

    const result = spawnSync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      resolve(root, "scripts", "test-anticodex-diagnostics.ps1"),
      "-VerifyReportsSummary",
      summaryPath,
    ], { encoding: "utf8", windowsHide: true, timeout: 15000 });
    assert.notEqual(result.status, 0, result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, false);
    assert.match(payload.failures.join("\n"), /missing release gate group evidence/);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("diagnostics reports-summary fixture rejects satisfied installed-runtime drift", () => {
  const tempRoot = mkdtempSync(join(os.tmpdir(), "anticodex-diagnostics-installed-drift-"));
  try {
    const summaryPath = join(tempRoot, "reports-summary.json");
    writeFileSync(summaryPath, JSON.stringify([
      minimalDiagnosticsReleaseGateSummary({
        installedRuntimeEvidence: {
          missingInstalledRuntimeFiles: ["scripts/anticodex-manager-bridge.mjs"],
        },
      }),
    ]), "utf8");

    const result = spawnSync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      resolve(root, "scripts", "test-anticodex-diagnostics.ps1"),
      "-VerifyReportsSummary",
      summaryPath,
    ], { encoding: "utf8", windowsHide: true, timeout: 15000 });
    assert.notEqual(result.status, 0, result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, false);
    assert.match(payload.failures.join("\n"), /satisfied with missingInstalledRuntimeFiles drift/);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("diagnostics reports-summary fixture rejects incomplete sync-readiness drift evidence", () => {
  const tempRoot = mkdtempSync(join(os.tmpdir(), "anticodex-diagnostics-sync-evidence-"));
  try {
    const summaryPath = join(tempRoot, "reports-summary.json");
    writeFileSync(summaryPath, JSON.stringify([{
      file: "latest-release-gates.json",
      ok: false,
      shortReady: false,
      releaseReady: false,
      effectiveOk: false,
      strictOptionalRealTraffic: false,
      optionalRealTrafficReady: false,
      optionalRealTrafficFailures: [],
      missingRequired: ["pluginCapabilities"],
      missingShort: ["pluginCapabilities"],
      missingOptional: [],
      damagedReports: [],
      releaseGateFailures: ["pluginCapabilities"],
      releaseGateFailureReasons: [{
        id: "pluginCapabilities",
        reportFailureSamples: ["health request failed"],
        reportFailureSampleCodes: ["local_gateway_offline"],
        offlineSnapshotEvidence: {
          connectorContentMatches: true,
          appToolContentMatches: true,
          refreshGateSatisfied: true,
          refreshSelectedFile: "latest-refresh-features.json",
          sourceFingerprint: "abc123",
          sourceFileCount: 2,
          sourceMtimeMax: "2026-06-24T00:00:00.000Z",
        },
      }],
      nextActions: [{
        id: "pluginCapabilities",
        command: "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\test-anticodex-plugin-capabilities.ps1 -TimeoutSec 45",
        requiresGatewayStart: true,
        requiresRealTraffic: false,
        highImpact: false,
        blockedUntilExplicitUserApproval: true,
      }],
      approvalPlan: {
        actionCount: 1,
        blockedCount: 1,
        requiresGatewayStartCount: 1,
        requiresRealTrafficCount: 0,
        highImpactCount: 0,
        reportOnlyCount: 0,
        firstBlockedAction: "pluginCapabilities",
      },
      releaseGateSelectedReports: [{ id: "syncReadiness", selectedFile: "20260624-sync-readiness.json" }],
      installedRuntimeEvidence: {
        satisfied: true,
        sourceFileCount: 2,
        installedRuntimeFileCount: 2,
        sourceFingerprint: "abc123",
        installedRuntimeFingerprint: "abc123",
        missingSourceFiles: [],
        missingInstalledRuntimeFiles: [],
        mismatchedRuntimeFiles: [],
      },
    }, {
      file: "latest-sync-readiness.json",
      ok: false,
      syncReadinessEvidence: {
        sourcePackageVersion: "26.623.3245.0",
        activePackageVersion: "26.616.9593.0",
        sourceHostHash: "SOURCEHOST",
        activeHostHash: "ACTIVEHOST",
        sourceCliHash: "SOURCECLI",
        activeCliHash: "ACTIVECLI",
        hostHashMatches: false,
        cliHashMatches: false,
      },
    }]), "utf8");

    const result = spawnSync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      resolve(root, "scripts", "test-anticodex-diagnostics.ps1"),
      "-VerifyReportsSummary",
      summaryPath,
    ], { encoding: "utf8", windowsHide: true, timeout: 15000 });
    assert.notEqual(result.status, 0, result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, false);
    assert.match(payload.failures.join("\n"), /sync-readiness summary missing update status reason/);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("diagnostics reports-summary fixture rejects non-plugin failure samples without codes", () => {
  const tempRoot = mkdtempSync(join(os.tmpdir(), "anticodex-diagnostics-gate-sample-codes-"));
  try {
    const summaryPath = join(tempRoot, "reports-summary.json");
    writeFileSync(summaryPath, JSON.stringify([{
      file: "latest-release-gates.json",
      ok: false,
      shortReady: false,
      releaseReady: false,
      effectiveOk: false,
      strictOptionalRealTraffic: false,
      optionalRealTrafficReady: false,
      optionalRealTrafficFailures: [],
      missingRequired: ["postVerification"],
      missingShort: [],
      missingOptional: [],
      damagedReports: [],
      releaseGateFailures: ["postVerification"],
      releaseGateFailureReasons: [{
        id: "postVerification",
        reportFailureSamples: ["gateway offline", "/health timeout"],
        reportFailureSampleCodes: [],
      }],
      nextActions: [{
        id: "postVerification",
        command: "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\test-anticodex-post-verification.ps1 -TimeoutMinutes 10",
        requiresGatewayStart: true,
        requiresRealTraffic: true,
        highImpact: true,
        blockedUntilExplicitUserApproval: true,
      }],
      approvalPlan: {
        actionCount: 1,
        blockedCount: 1,
        requiresGatewayStartCount: 1,
        requiresRealTrafficCount: 1,
        highImpactCount: 1,
        firstBlockedAction: "postVerification",
      },
      releaseGateSelectedReports: [{ id: "syncReadiness", selectedFile: "20260624-sync-readiness.json" }],
      installedRuntimeEvidence: {
        satisfied: true,
        sourceFileCount: 2,
        installedRuntimeFileCount: 2,
        sourceFingerprint: "abc123",
        installedRuntimeFingerprint: "abc123",
        missingSourceFiles: [],
        missingInstalledRuntimeFiles: [],
        mismatchedRuntimeFiles: [],
      },
    }]), "utf8");

    const result = spawnSync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      resolve(root, "scripts", "test-anticodex-diagnostics.ps1"),
      "-VerifyReportsSummary",
      summaryPath,
    ], { encoding: "utf8", windowsHide: true, timeout: 15000 });
    assert.equal(result.status, 1, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, false);
    assert.ok(payload.failures.includes("release-gates failure postVerification missing sample codes"));
    assert.equal(payload.diagnostics, null);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("diagnostics reports-summary fixture rejects null approval plan object", () => {
  const tempRoot = mkdtempSync(join(os.tmpdir(), "anticodex-diagnostics-null-plan-object-"));
  try {
    const summaryPath = join(tempRoot, "reports-summary.json");
    writeFileSync(summaryPath, JSON.stringify([{
      file: "latest-release-gates.json",
      ok: false,
      shortReady: false,
      releaseReady: false,
      effectiveOk: false,
      strictOptionalRealTraffic: false,
      optionalRealTrafficReady: false,
      optionalRealTrafficFailures: [],
      missingRequired: ["pluginCapabilities"],
      missingShort: ["pluginCapabilities"],
      missingOptional: [],
      damagedReports: [],
      releaseGateFailures: ["pluginCapabilities"],
      releaseGateFailureReasons: [],
      nextActions: [{
        id: "pluginCapabilities",
        command: "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\test-anticodex-plugin-capabilities.ps1 -TimeoutSec 45",
        requiresGatewayStart: true,
        requiresRealTraffic: false,
        highImpact: false,
        blockedUntilExplicitUserApproval: true,
      }],
      approvalPlan: null,
      releaseGateGroups: [],
      releaseGateSelectedReports: [{ id: "syncReadiness", selectedFile: "20260624-sync-readiness.json" }],
      installedRuntimeEvidence: {
        satisfied: true,
        sourceFileCount: 2,
        installedRuntimeFileCount: 2,
        sourceFingerprint: "abc123",
        installedRuntimeFingerprint: "abc123",
        missingSourceFiles: [],
        missingInstalledRuntimeFiles: [],
        mismatchedRuntimeFiles: [],
      },
    }]), "utf8");

    const result = spawnSync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      resolve(root, "scripts", "test-anticodex-diagnostics.ps1"),
      "-VerifyReportsSummary",
      summaryPath,
    ], { encoding: "utf8", windowsHide: true, timeout: 15000 });
    assert.equal(result.status, 1, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, false);
    assert.ok(payload.failures.includes("release-gates approval plan is not an object"));
    assert.equal(payload.diagnostics, null);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("diagnostics reports-summary fixture rejects weak plugin offline snapshot evidence", () => {
  const tempRoot = mkdtempSync(join(os.tmpdir(), "anticodex-diagnostics-plugin-offline-summary-"));
  try {
    const summaryPath = join(tempRoot, "reports-summary.json");
    writeFileSync(summaryPath, JSON.stringify([{
      file: "latest-release-gates.json",
      ok: false,
      shortReady: false,
      releaseReady: false,
      effectiveOk: false,
      strictOptionalRealTraffic: false,
      optionalRealTrafficReady: false,
      optionalRealTrafficFailures: [],
      missingRequired: ["pluginCapabilities"],
      missingShort: ["pluginCapabilities"],
      missingOptional: [],
      damagedReports: [],
      releaseGateFailures: ["pluginCapabilities"],
      releaseGateFailureReasons: [{
        id: "pluginCapabilities",
        reportFailureSamples: ["health request failed"],
        reportFailureSampleCodes: ["local_gateway_offline"],
        offlineSnapshotEvidence: {
          connectorContentMatches: true,
          appToolContentMatches: true,
          refreshGateSatisfied: false,
          refreshSelectedFile: "",
        },
      }],
      nextActions: [],
      approvalPlan: {
        actionCount: 0,
        blockedCount: 0,
        requiresGatewayStartCount: 0,
        requiresRealTrafficCount: 0,
        highImpactCount: 0,
        firstBlockedAction: "",
      },
      releaseGateGroups: [],
      releaseGateSelectedReports: [{ id: "syncReadiness", selectedFile: "20260624-sync-readiness.json" }],
      installedRuntimeEvidence: {
        satisfied: true,
        sourceFileCount: 2,
        installedRuntimeFileCount: 2,
        sourceFingerprint: "abc123",
        installedRuntimeFingerprint: "abc123",
        missingSourceFiles: [],
        missingInstalledRuntimeFiles: [],
        mismatchedRuntimeFiles: [],
      },
    }]), "utf8");

    const result = spawnSync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      resolve(root, "scripts", "test-anticodex-diagnostics.ps1"),
      "-VerifyReportsSummary",
      summaryPath,
    ], { encoding: "utf8", windowsHide: true, timeout: 15000 });
    assert.equal(result.status, 1, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, false);
    assert.ok(payload.failures.includes("plugin capability failure offline refresh gate is not satisfied"));
    assert.ok(payload.failures.includes("plugin capability failure offline refresh selected file missing"));
    assert.ok(payload.failures.includes("plugin capability failure offline source fingerprint missing"));
    assert.ok(payload.failures.includes("plugin capability failure offline source file count missing"));
    assert.ok(payload.failures.includes("plugin capability failure offline source mtime missing"));
    assert.equal(payload.diagnostics, null);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("diagnostics reports-summary fixture rejects incomplete local connector evidence", () => {
  const tempRoot = mkdtempSync(join(os.tmpdir(), "anticodex-diagnostics-local-summary-"));
  try {
    const summaryPath = join(tempRoot, "reports-summary.json");
    writeFileSync(summaryPath, JSON.stringify([{
      file: "latest-release-gates.json",
      ok: true,
      shortReady: true,
      releaseReady: true,
      effectiveOk: true,
      strictOptionalRealTraffic: false,
      optionalRealTrafficReady: false,
      optionalRealTrafficFailures: [],
      missingRequired: [],
      missingShort: [],
      missingOptional: [],
      damagedReports: [],
      releaseGateFailures: [],
      releaseGateFailureReasons: [],
      nextActions: [],
      approvalPlan: { actionCount: 0, requiresGatewayStartCount: 0 },
      releaseGateGroups: [],
      releaseGateSelectedReports: [{ id: "syncReadiness", selectedFile: "20260624-sync-readiness.json" }],
      installedRuntimeEvidence: {
        satisfied: true,
        sourceFileCount: 2,
        installedRuntimeFileCount: 2,
        sourceFingerprint: "abc123",
        installedRuntimeFingerprint: "abc123",
        missingSourceFiles: [],
        missingInstalledRuntimeFiles: [],
        mismatchedRuntimeFiles: [],
      },
    }, {
      file: "latest-local-connectors.json",
      ok: true,
      reportName: "local-connectors",
      usedRealTraffic: false,
      behaviorCovered: true,
      coverageKind: "local-fake-provider",
      localConnectorEvidence: {
        linkedConnectorAccessible: true,
        chatgptInstallUrlsScrubbed: true,
        linkEndpointsUnsupported: true,
        upstreamRequestsBeforeLocalEndpoints: 1,
        upstreamRequestsAfterLocalEndpoints: 1,
        upstreamRequestsDuringLocalEndpoints: 0,
        allowlistedConnectorAccessible: false,
        allowlistedConnectorLocallyAllowlisted: true,
        hiddenConnectorAccessible: false,
        exposedToolsPost: 1,
        exposedToolsGet: 1,
        exposedToolNames: ["linked_tool"],
        connectorParityClean: true,
        connectorFingerprintMatches: true,
        appToolParityClean: true,
        appToolFingerprintMatches: true,
        appToolGetPostParityClean: true,
        tempSharedHomeUsed: false,
        tempCodexHomeUnderStateRoot: true,
        tempSharedCodexHomeUnderStateRoot: true,
        tempCodexHomeDistinctFromShared: true,
      },
    }]), "utf8");

    const result = spawnSync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      resolve(root, "scripts", "test-anticodex-diagnostics.ps1"),
      "-VerifyReportsSummary",
      summaryPath,
    ], { encoding: "utf8", windowsHide: true, timeout: 15000 });
    assert.equal(result.status, 1, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, false);
    assert.ok(payload.failures.includes("local connector summary missing connector missing-shared drift samples"));
    assert.ok(payload.failures.includes("local connector summary missing app-tool changed-shared drift samples"));
    assert.equal(payload.diagnostics, null);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("diagnostics reports-summary fixture rejects unsafe next action approval metadata", () => {
  const tempRoot = mkdtempSync(join(os.tmpdir(), "anticodex-diagnostics-action-summary-"));
  try {
    const summaryPath = join(tempRoot, "reports-summary.json");
    writeFileSync(summaryPath, JSON.stringify([{
      file: "latest-release-gates.json",
      ok: false,
      shortReady: false,
      releaseReady: false,
      effectiveOk: false,
      strictOptionalRealTraffic: false,
      optionalRealTrafficReady: false,
      optionalRealTrafficFailures: [],
      missingRequired: ["postVerification"],
      missingShort: [],
      missingOptional: [],
      damagedReports: [],
      releaseGateFailures: ["postVerification"],
      releaseGateFailureReasons: [],
      nextActions: [{
        id: "postVerification",
        command: "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\test-anticodex-post-verification.ps1 -TimeoutMinutes 10",
        requiresGatewayStart: true,
        requiresRealTraffic: true,
        highImpact: true,
      }],
      approvalPlan: {
        actionCount: 1,
        blockedCount: 0,
        requiresGatewayStartCount: 0,
        requiresRealTrafficCount: 0,
        highImpactCount: 0,
        firstBlockedAction: "",
      },
      releaseGateGroups: [],
      releaseGateSelectedReports: [{ id: "syncReadiness", selectedFile: "20260624-sync-readiness.json" }],
      installedRuntimeEvidence: {
        satisfied: true,
        sourceFileCount: 2,
        installedRuntimeFileCount: 2,
        sourceFingerprint: "abc123",
        installedRuntimeFingerprint: "abc123",
        missingSourceFiles: [],
        missingInstalledRuntimeFiles: [],
        mismatchedRuntimeFiles: [],
      },
    }]), "utf8");

    const result = spawnSync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      resolve(root, "scripts", "test-anticodex-diagnostics.ps1"),
      "-VerifyReportsSummary",
      summaryPath,
    ], { encoding: "utf8", windowsHide: true, timeout: 15000 });
    assert.equal(result.status, 1, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, false);
    assert.ok(payload.failures.includes("release-gates next action postVerification missing explicit approval block"));
    assert.ok(payload.failures.includes("release-gates approval plan undercounts real-traffic actions"));
    assert.ok(payload.failures.includes("release-gates approval plan missing first blocked action"));
    assert.equal(payload.diagnostics, null);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("diagnostics reports-summary fixture rejects real-traffic-only gateway-start first action", () => {
  const tempRoot = mkdtempSync(join(os.tmpdir(), "anticodex-diagnostics-real-traffic-first-action-"));
  try {
    const summaryPath = join(tempRoot, "reports-summary.json");
    writeFileSync(summaryPath, JSON.stringify([minimalDiagnosticsReleaseGateSummary({
      shortReady: true,
      releaseBlockedOnlyByRequiredRealTraffic: true,
      requiredRealTrafficBlockedGates: ["postVerification"],
      missingRequired: ["postVerification"],
      releaseGateFailures: ["postVerification"],
      releaseGateFailureReasons: [{
        id: "postVerification",
        failureReasons: ["stale_report"],
        failureReasonsAvailableCount: 1,
        failureReasonsHiddenCount: 0,
        reportFailureSamples: ["post verification stale"],
        reportFailureSampleCodes: ["stale_report"],
        guidance: "real_traffic_evidence_stale: rerun post verification after explicit approval.",
        requiredForRelease: true,
        orderedActions: [],
      }],
      nextActions: [{
        id: "postVerification",
        gateId: "postVerification",
        phase: "real-traffic-final",
        command: "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\test-anticodex-post-verification.ps1 -TimeoutMinutes 10",
        reason: "stale_report",
        guidance: "real_traffic_evidence_stale: requires explicit user approval.",
        requiresRealTraffic: true,
        highImpact: true,
        blockedUntilExplicitUserApproval: true,
      }],
      nextActionsAvailableCount: 1,
      nextActionsHiddenCount: 0,
      nextActionsTruncated: false,
      approvalPlan: {
        actionCount: 1,
        blockedCount: 1,
        requiresGatewayStartCount: 0,
        requiresRealTrafficCount: 1,
        highImpactCount: 1,
        reportOnlyCount: 0,
        requiredForShortCount: 0,
        requiredForReleaseCount: 0,
        firstBlockedAction: "startGatewayTranslatorOnly",
      },
    })]), "utf8");

    const result = spawnSync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      resolve(root, "scripts", "test-anticodex-diagnostics.ps1"),
      "-VerifyReportsSummary",
      summaryPath,
    ], { encoding: "utf8", windowsHide: true, timeout: 15000 });
    assert.equal(result.status, 1, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, false);
    assert.ok(payload.failures.includes("release-gates real-traffic-only blocker approval plan points at gateway start"));
    assert.equal(payload.diagnostics, null);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("diagnostics reports-summary fixture rejects next action truncation count mismatches", () => {
  const tempRoot = mkdtempSync(join(os.tmpdir(), "anticodex-diagnostics-next-action-count-summary-"));
  try {
    const summaryPath = join(tempRoot, "reports-summary.json");
    writeFileSync(summaryPath, JSON.stringify([{
      file: "latest-release-gates.json",
      ok: false,
      shortReady: false,
      releaseReady: false,
      effectiveOk: false,
      strictOptionalRealTraffic: false,
      optionalRealTrafficReady: true,
      optionalRealTrafficFailures: [],
      missingRequired: ["postVerification"],
      missingShort: [],
      missingOptional: [],
      damagedReports: [],
      releaseGateFailures: ["postVerification"],
      releaseGateFailureReasons: [{
        id: "postVerification",
        failureReasons: ["stale_report"],
        guidance: "real_traffic_evidence_stale: requires explicit user approval to start/verify Anti-Codex and refresh release-grade real-traffic reports.",
      }],
      nextActions: [{
        id: "postVerification",
        command: "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\test-anticodex-post-verification.ps1 -TimeoutMinutes 10",
        requiresGatewayStart: true,
        requiresRealTraffic: true,
        highImpact: true,
        blockedUntilExplicitUserApproval: true,
      }],
      nextActionsAvailableCount: 5,
      nextActionsHiddenCount: 3,
      nextActionsTruncated: false,
      approvalPlan: {
        actionCount: 1,
        blockedCount: 1,
        requiresGatewayStartCount: 1,
        requiresRealTrafficCount: 1,
        highImpactCount: 1,
        reportOnlyCount: 0,
        firstBlockedAction: "postVerification",
      },
      releaseGateGroups: [],
      releaseGateSelectedReports: [{ id: "syncReadiness", selectedFile: "20260624-sync-readiness.json" }],
      installedRuntimeEvidence: {
        satisfied: true,
        sourceFileCount: 2,
        installedRuntimeFileCount: 2,
        sourceFingerprint: "abc123",
        installedRuntimeFingerprint: "abc123",
        missingSourceFiles: [],
        missingInstalledRuntimeFiles: [],
        mismatchedRuntimeFiles: [],
      },
    }]), "utf8");

    const result = spawnSync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      resolve(root, "scripts", "test-anticodex-diagnostics.ps1"),
      "-VerifyReportsSummary",
      summaryPath,
    ], { encoding: "utf8", windowsHide: true, timeout: 15000 });
    assert.equal(result.status, 1, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, false);
    assert.ok(payload.failures.includes("release-gates summary nextActions hidden count mismatch"));
    assert.ok(payload.failures.includes("release-gates summary nextActions truncated flag mismatch"));
    assert.equal(payload.diagnostics, null);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("diagnostics reports-summary fixture rejects command risk metadata mismatch", () => {
  const tempRoot = mkdtempSync(join(os.tmpdir(), "anticodex-diagnostics-action-command-summary-"));
  try {
    const summaryPath = join(tempRoot, "reports-summary.json");
    writeFileSync(summaryPath, JSON.stringify([{
      file: "latest-release-gates.json",
      ok: false,
      shortReady: false,
      releaseReady: false,
      effectiveOk: false,
      strictOptionalRealTraffic: false,
      optionalRealTrafficReady: false,
      optionalRealTrafficFailures: [],
      missingRequired: ["realMiniTool"],
      missingShort: [],
      missingOptional: [],
      damagedReports: [],
      releaseGateFailures: ["realMiniTool"],
      releaseGateFailureReasons: [],
      nextActions: [{
        id: "realMiniTool",
        command: "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\test-anticodex-real-mini-tool.ps1 -TimeoutSec 90 -AllowRealTraffic",
        requiresGatewayStart: false,
        requiresRealTraffic: false,
        highImpact: false,
        blockedUntilExplicitUserApproval: true,
      }],
      approvalPlan: {
        actionCount: 1,
        blockedCount: 1,
        requiresGatewayStartCount: 0,
        requiresRealTrafficCount: 0,
        highImpactCount: 0,
        firstBlockedAction: "realMiniTool",
      },
      releaseGateGroups: [],
      releaseGateSelectedReports: [{ id: "syncReadiness", selectedFile: "20260624-sync-readiness.json" }],
      installedRuntimeEvidence: {
        satisfied: true,
        sourceFileCount: 2,
        installedRuntimeFileCount: 2,
        sourceFingerprint: "abc123",
        installedRuntimeFingerprint: "abc123",
        missingSourceFiles: [],
        missingInstalledRuntimeFiles: [],
        mismatchedRuntimeFiles: [],
      },
    }]), "utf8");

    const result = spawnSync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      resolve(root, "scripts", "test-anticodex-diagnostics.ps1"),
      "-VerifyReportsSummary",
      summaryPath,
    ], { encoding: "utf8", windowsHide: true, timeout: 15000 });
    assert.equal(result.status, 1, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, false);
    assert.ok(payload.failures.includes("release-gates next action realMiniTool command requires gateway metadata"));
    assert.ok(payload.failures.includes("release-gates next action realMiniTool command requires real-traffic metadata"));
    assert.ok(payload.failures.includes("release-gates next action realMiniTool command requires high-impact metadata"));
    assert.equal(payload.diagnostics, null);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("diagnostics reports-summary fixture rejects nested ordered action risk metadata mismatch", () => {
  const tempRoot = mkdtempSync(join(os.tmpdir(), "anticodex-diagnostics-nested-action-summary-"));
  try {
    const summaryPath = join(tempRoot, "reports-summary.json");
    writeFileSync(summaryPath, JSON.stringify([{
      file: "latest-release-gates.json",
      ok: false,
      shortReady: false,
      releaseReady: false,
      effectiveOk: false,
      strictOptionalRealTraffic: false,
      optionalRealTrafficReady: false,
      optionalRealTrafficFailures: [],
      missingRequired: ["realMiniTool"],
      missingShort: [],
      missingOptional: [],
      damagedReports: [],
      releaseGateFailures: ["realMiniTool"],
      releaseGateFailureReasons: [{
        id: "realMiniTool",
        reportFailureSamples: ["stale report"],
        reportFailureSampleCodes: ["stale_report"],
        orderedActions: [{
          id: "realMiniTool",
          command: "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\test-anticodex-real-mini-tool.ps1 -TimeoutSec 90 -AllowRealTraffic",
          requiresGatewayStart: false,
          requiresRealTraffic: false,
          highImpact: false,
          blockedUntilExplicitUserApproval: true,
        }],
      }],
      nextActions: [{
        id: "realMiniTool",
        command: "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\test-anticodex-real-mini-tool.ps1 -TimeoutSec 90 -AllowRealTraffic",
        requiresGatewayStart: true,
        requiresRealTraffic: true,
        highImpact: true,
        blockedUntilExplicitUserApproval: true,
      }],
      approvalPlan: {
        actionCount: 1,
        blockedCount: 1,
        requiresGatewayStartCount: 1,
        requiresRealTrafficCount: 1,
        highImpactCount: 1,
        reportOnlyCount: 0,
        firstBlockedAction: "realMiniTool",
      },
      releaseGateGroups: [],
      releaseGateSelectedReports: [{ id: "syncReadiness", selectedFile: "20260624-sync-readiness.json" }],
      installedRuntimeEvidence: {
        satisfied: true,
        sourceFileCount: 2,
        installedRuntimeFileCount: 2,
        sourceFingerprint: "abc123",
        installedRuntimeFingerprint: "abc123",
        missingSourceFiles: [],
        missingInstalledRuntimeFiles: [],
        mismatchedRuntimeFiles: [],
      },
    }]), "utf8");

    const result = spawnSync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      resolve(root, "scripts", "test-anticodex-diagnostics.ps1"),
      "-VerifyReportsSummary",
      summaryPath,
    ], { encoding: "utf8", windowsHide: true, timeout: 15000 });
    assert.equal(result.status, 1, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, false);
    assert.ok(payload.failures.includes("release-gates ordered action realMiniTool/realMiniTool command requires gateway metadata"));
    assert.ok(payload.failures.includes("release-gates ordered action realMiniTool/realMiniTool command requires real-traffic metadata"));
    assert.ok(payload.failures.includes("release-gates ordered action realMiniTool/realMiniTool command requires high-impact metadata"));
    assert.equal(payload.diagnostics, null);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("diagnostics reports-summary fixture rejects action gates without guidance", () => {
  const tempRoot = mkdtempSync(join(os.tmpdir(), "anticodex-diagnostics-guidance-summary-"));
  try {
    const summaryPath = join(tempRoot, "reports-summary.json");
    writeFileSync(summaryPath, JSON.stringify([{
      file: "latest-release-gates.json",
      ok: false,
      shortReady: false,
      releaseReady: false,
      effectiveOk: false,
      strictOptionalRealTraffic: false,
      optionalRealTrafficReady: false,
      optionalRealTrafficFailures: [],
      missingRequired: ["managerRealButtons"],
      missingShort: ["managerRealButtons"],
      missingOptional: [],
      damagedReports: [],
      releaseGateFailures: ["managerRealButtons"],
      releaseGateFailureReasons: [{
        id: "managerRealButtons",
        failureReasons: ["stale_report"],
        guidance: "",
        orderedActions: [{
          id: "managerRealButtons",
          command: "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\test-anticodex-manager-real-buttons.ps1 -TimeoutSec 120",
          requiresGatewayStart: true,
          requiresRealTraffic: false,
          highImpact: false,
          blockedUntilExplicitUserApproval: true,
        }],
      }],
      nextActions: [{
        id: "managerRealButtons",
        command: "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\test-anticodex-manager-real-buttons.ps1 -TimeoutSec 120",
        requiresGatewayStart: true,
        requiresRealTraffic: false,
        highImpact: false,
        blockedUntilExplicitUserApproval: true,
      }],
      approvalPlan: {
        actionCount: 1,
        blockedCount: 1,
        requiresGatewayStartCount: 1,
        requiresRealTrafficCount: 0,
        highImpactCount: 0,
        reportOnlyCount: 0,
        firstBlockedAction: "managerRealButtons",
      },
      releaseGateGroups: [],
      releaseGateSelectedReports: [{ id: "syncReadiness", selectedFile: "20260624-sync-readiness.json" }],
      installedRuntimeEvidence: {
        satisfied: true,
        sourceFileCount: 2,
        installedRuntimeFileCount: 2,
        sourceFingerprint: "abc123",
        installedRuntimeFingerprint: "abc123",
        missingSourceFiles: [],
        missingInstalledRuntimeFiles: [],
        mismatchedRuntimeFiles: [],
      },
    }]), "utf8");

    const result = spawnSync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      resolve(root, "scripts", "test-anticodex-diagnostics.ps1"),
      "-VerifyReportsSummary",
      summaryPath,
    ], { encoding: "utf8", windowsHide: true, timeout: 15000 });
    assert.equal(result.status, 1, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, false);
    assert.ok(payload.failures.includes("release-gates next action managerRealButtons missing guidance"));
    assert.ok(payload.failures.includes("release-gates next action managerRealButtons missing reason"));
    assert.ok(payload.failures.includes("release-gates failure managerRealButtons with ordered actions missing guidance"));
    assert.ok(payload.failures.includes("release-gates ordered action managerRealButtons/managerRealButtons missing guidance"));
    assert.ok(payload.failures.includes("release-gates ordered action managerRealButtons/managerRealButtons missing reason"));
    assert.equal(payload.diagnostics, null);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("diagnostics reports-summary fixture rejects optional real-traffic failures without guidance", () => {
  const tempRoot = mkdtempSync(join(os.tmpdir(), "anticodex-diagnostics-optional-guidance-"));
  try {
    const summaryPath = join(tempRoot, "reports-summary.json");
    writeFileSync(summaryPath, JSON.stringify([{
      file: "latest-release-gates.json",
      ok: false,
      shortReady: true,
      releaseReady: true,
      effectiveOk: true,
      strictOptionalRealTraffic: true,
      optionalRealTrafficReady: false,
      optionalRealTrafficFailures: ["realThirdPartyProviderOptional"],
      missingRequired: [],
      missingShort: [],
      missingOptional: [],
      damagedReports: [],
      releaseGateFailures: ["realThirdPartyProviderOptional"],
      releaseGateFailureReasons: [{
        id: "realThirdPartyProviderOptional",
        failureReasons: ["stale_report"],
        guidance: "",
        orderedActions: [],
      }],
      nextActions: [],
      approvalPlan: {
        actionCount: 0,
        blockedCount: 0,
        requiresGatewayStartCount: 0,
        requiresRealTrafficCount: 0,
        highImpactCount: 0,
        reportOnlyCount: 0,
        firstBlockedAction: "",
      },
      releaseGateSelectedReports: [{ id: "syncReadiness", selectedFile: "20260624-sync-readiness.json" }],
      installedRuntimeEvidence: {
        satisfied: true,
        sourceFileCount: 2,
        installedRuntimeFileCount: 2,
        sourceFingerprint: "abc123",
        installedRuntimeFingerprint: "abc123",
        missingSourceFiles: [],
        missingInstalledRuntimeFiles: [],
        mismatchedRuntimeFiles: [],
      },
    }]), "utf8");

    const result = spawnSync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      resolve(root, "scripts", "test-anticodex-diagnostics.ps1"),
      "-VerifyReportsSummary",
      summaryPath,
    ], { encoding: "utf8", windowsHide: true, timeout: 15000 });
    assert.equal(result.status, 1, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, false);
    assert.ok(payload.failures.includes("release-gates optional real-traffic failure realThirdPartyProviderOptional missing guidance"));
    assert.ok(payload.failures.includes("release-gates releaseReady true while strict optional real-traffic is not ready"));
    assert.equal(payload.diagnostics, null);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("diagnostics reports-summary fixture rejects optional ready with failures", () => {
  const tempRoot = mkdtempSync(join(os.tmpdir(), "anticodex-diagnostics-optional-ready-failures-"));
  try {
    const summaryPath = join(tempRoot, "reports-summary.json");
    writeFileSync(summaryPath, JSON.stringify([minimalDiagnosticsReleaseGateSummary({
      ok: false,
      shortReady: true,
      releaseReady: false,
      effectiveOk: false,
      strictOptionalRealTraffic: false,
      optionalRealTrafficReady: true,
      optionalRealTrafficFailures: ["realThirdPartyProviderOptional"],
      releaseGateFailures: ["realThirdPartyProviderOptional"],
      releaseGateFailureReasons: [{
        id: "realThirdPartyProviderOptional",
        requiredForShort: false,
        requiredForRelease: false,
        failureReasons: ["stale_report"],
        failureReasonsAvailableCount: 1,
        failureReasonsHiddenCount: 0,
        guidance: "optional_real_provider_required: run only with explicit approval and environment-variable API key.",
        orderedActions: [],
      }],
    })]), "utf8");

    const result = spawnSync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      resolve(root, "scripts", "test-anticodex-diagnostics.ps1"),
      "-VerifyReportsSummary",
      summaryPath,
    ], { encoding: "utf8", windowsHide: true, timeout: 15000 });
    assert.equal(result.status, 1, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, false);
    assert.ok(payload.failures.includes("release-gates optional real-traffic ready has failures"));
    assert.equal(payload.diagnostics, null);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("diagnostics reports-summary fixture rejects inconsistent effectiveOk", () => {
  const tempRoot = mkdtempSync(join(os.tmpdir(), "anticodex-diagnostics-effective-ok-summary-"));
  try {
    const summaryPath = join(tempRoot, "reports-summary.json");
    writeFileSync(summaryPath, JSON.stringify([minimalDiagnosticsReleaseGateSummary({
      ok: true,
      shortReady: true,
      releaseReady: false,
      effectiveOk: true,
      damagedReports: ["latest-model-routing.json"],
      releaseGateFailureReasons: [{
        id: "latest-model-routing.json",
        file: "latest-model-routing.json",
        failureReasons: ["damaged_report"],
        failureReasonsAvailableCount: 1,
        failureReasonsHiddenCount: 0,
        reportFailureSamples: ["hash mismatch"],
        reportFailureSampleCodes: ["hash_mismatch"],
        guidance: "releaseGateReportOnlyCheck: inspect damaged release-gate report before rerun.",
        orderedActions: [],
      }],
    })]), "utf8");

    const result = spawnSync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      resolve(root, "scripts", "test-anticodex-diagnostics.ps1"),
      "-VerifyReportsSummary",
      summaryPath,
    ], { encoding: "utf8", windowsHide: true, timeout: 15000 });
    assert.equal(result.status, 1, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, false);
    assert.ok(payload.failures.includes("release-gates effectiveOk true while releaseReady is not true"));
    assert.ok(payload.failures.includes("release-gates effectiveOk true with damaged reports"));
    assert.equal(payload.diagnostics, null);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("diagnostics reports-summary fixture rejects ready states with missing gates", () => {
  const tempRoot = mkdtempSync(join(os.tmpdir(), "anticodex-diagnostics-ready-missing-summary-"));
  try {
    const summaryPath = join(tempRoot, "reports-summary.json");
    writeFileSync(summaryPath, JSON.stringify([minimalDiagnosticsReleaseGateSummary({
      ok: true,
      shortReady: true,
      releaseReady: true,
      effectiveOk: true,
      missingShort: ["managerRealButtons"],
      missingRequired: ["postVerification"],
      releaseGateFailureReasons: [
        {
          id: "managerRealButtons",
          file: "latest-manager-real-buttons.json",
          failureReasons: ["stale_report"],
          failureReasonsAvailableCount: 1,
          failureReasonsHiddenCount: 0,
          requiredForShort: true,
          requiredForRelease: false,
          guidance: "managerRealButtons: rerun real Manager button verifier before release.",
          orderedActions: [],
        },
        {
          id: "postVerification",
          file: "latest-post-verification.json",
          failureReasons: ["missing_report"],
          failureReasonsAvailableCount: 1,
          failureReasonsHiddenCount: 0,
          requiredForShort: false,
          requiredForRelease: true,
          guidance: "postVerification: run the explicit post-verification verifier.",
          orderedActions: [],
        },
      ],
      nextActions: [
        { id: "managerRealButtons", gateId: "managerRealButtons", command: "test-manager-real-buttons", reason: "stale_report", guidance: "managerRealButtons: rerun real Manager button verifier before release.", commandRisk: "approval_required", commandRiskSummary: "approval required", approvalRequired: true, realTraffic: false, reportOnly: false, highImpact: true, blocked: true },
        { id: "postVerification", gateId: "postVerification", command: "test-post-verification", reason: "missing_report", guidance: "postVerification: run the explicit post-verification verifier.", commandRisk: "approval_required", commandRiskSummary: "approval required", approvalRequired: true, realTraffic: true, reportOnly: false, highImpact: true, blocked: true },
      ],
    })]), "utf8");

    const result = spawnSync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      resolve(root, "scripts", "test-anticodex-diagnostics.ps1"),
      "-VerifyReportsSummary",
      summaryPath,
    ], { encoding: "utf8", windowsHide: true, timeout: 15000 });
    assert.equal(result.status, 1, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, false);
    assert.ok(payload.failures.includes("release-gates shortReady true with missing short gates"));
    assert.ok(payload.failures.includes("release-gates releaseReady true with missing required gates"));
    assert.equal(payload.diagnostics, null);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("diagnostics reports-summary fixture rejects gate failures without details", () => {
  const tempRoot = mkdtempSync(join(os.tmpdir(), "anticodex-diagnostics-gate-detail-summary-"));
  try {
    const summaryPath = join(tempRoot, "reports-summary.json");
    writeFileSync(summaryPath, JSON.stringify([{
      file: "latest-release-gates.json",
      ok: false,
      shortReady: false,
      releaseReady: false,
      effectiveOk: false,
      strictOptionalRealTraffic: false,
      optionalRealTrafficReady: false,
      optionalRealTrafficFailures: [],
      missingRequired: ["postVerification"],
      missingShort: [],
      missingOptional: [],
      damagedReports: [],
      releaseGateFailures: ["postVerification"],
      releaseGateFailureReasons: [],
      nextActions: [{
        id: "postVerification",
        command: "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\test-anticodex-post-verification.ps1 -TimeoutMinutes 10",
        requiresGatewayStart: true,
        requiresRealTraffic: true,
        highImpact: true,
        blockedUntilExplicitUserApproval: true,
      }],
      approvalPlan: {
        actionCount: 1,
        blockedCount: 1,
        requiresGatewayStartCount: 1,
        requiresRealTrafficCount: 1,
        highImpactCount: 1,
        reportOnlyCount: 0,
        firstBlockedAction: "postVerification",
      },
      releaseGateGroups: [],
      releaseGateSelectedReports: [{ id: "syncReadiness", selectedFile: "20260624-sync-readiness.json" }],
      installedRuntimeEvidence: {
        satisfied: true,
        sourceFileCount: 2,
        installedRuntimeFileCount: 2,
        sourceFingerprint: "abc123",
        installedRuntimeFingerprint: "abc123",
        missingSourceFiles: [],
        missingInstalledRuntimeFiles: [],
        mismatchedRuntimeFiles: [],
      },
    }]), "utf8");

    const result = spawnSync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      resolve(root, "scripts", "test-anticodex-diagnostics.ps1"),
      "-VerifyReportsSummary",
      summaryPath,
    ], { encoding: "utf8", windowsHide: true, timeout: 15000 });
    assert.equal(result.status, 1, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, false);
    assert.ok(payload.failures.includes("release-gates failure postVerification missing failure reason details"));
    assert.equal(payload.diagnostics, null);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("diagnostics reports-summary fixture rejects damaged reports without details", () => {
  const tempRoot = mkdtempSync(join(os.tmpdir(), "anticodex-diagnostics-damaged-detail-summary-"));
  try {
    const summaryPath = join(tempRoot, "reports-summary.json");
    writeFileSync(summaryPath, JSON.stringify([{
      file: "latest-release-gates.json",
      ok: false,
      shortReady: false,
      releaseReady: false,
      effectiveOk: false,
      strictOptionalRealTraffic: false,
      optionalRealTrafficReady: true,
      optionalRealTrafficFailures: [],
      missingRequired: [],
      missingShort: [],
      missingOptional: [],
      damagedReports: ["latest-model-routing.json"],
      releaseGateFailures: [],
      releaseGateFailureReasons: [],
      nextActions: [],
      approvalPlan: {
        actionCount: 0,
        blockedCount: 0,
        requiresGatewayStartCount: 0,
        requiresRealTrafficCount: 0,
        highImpactCount: 0,
        reportOnlyCount: 0,
        firstBlockedAction: "",
      },
      releaseGateSelectedReports: [{ id: "syncReadiness", selectedFile: "20260624-sync-readiness.json" }],
      installedRuntimeEvidence: {
        satisfied: true,
        sourceFileCount: 2,
        installedRuntimeFileCount: 2,
        sourceFingerprint: "abc123",
        installedRuntimeFingerprint: "abc123",
        missingSourceFiles: [],
        missingInstalledRuntimeFiles: [],
        mismatchedRuntimeFiles: [],
      },
    }]), "utf8");

    const result = spawnSync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      resolve(root, "scripts", "test-anticodex-diagnostics.ps1"),
      "-VerifyReportsSummary",
      summaryPath,
    ], { encoding: "utf8", windowsHide: true, timeout: 15000 });
    assert.equal(result.status, 1, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, false);
    assert.ok(payload.failures.includes("release-gates damaged report latest-model-routing.json missing failure reason details"));
    assert.equal(payload.diagnostics, null);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("diagnostics reports-summary fixture rejects missing required gates without details", () => {
  const tempRoot = mkdtempSync(join(os.tmpdir(), "anticodex-diagnostics-required-detail-summary-"));
  try {
    const summaryPath = join(tempRoot, "reports-summary.json");
    writeFileSync(summaryPath, JSON.stringify([{
      file: "latest-release-gates.json",
      ok: false,
      shortReady: false,
      releaseReady: false,
      effectiveOk: false,
      strictOptionalRealTraffic: false,
      optionalRealTrafficReady: false,
      optionalRealTrafficFailures: [],
      missingRequired: ["postVerification"],
      missingShort: [],
      missingOptional: [],
      damagedReports: [],
      releaseGateFailures: [],
      releaseGateFailureReasons: [],
      nextActions: [{
        id: "postVerification",
        command: "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\test-anticodex-post-verification.ps1 -TimeoutMinutes 10",
        requiresGatewayStart: true,
        requiresRealTraffic: true,
        highImpact: true,
        blockedUntilExplicitUserApproval: true,
      }],
      approvalPlan: {
        actionCount: 1,
        blockedCount: 1,
        requiresGatewayStartCount: 1,
        requiresRealTrafficCount: 1,
        highImpactCount: 1,
        reportOnlyCount: 0,
        firstBlockedAction: "postVerification",
      },
      releaseGateGroups: [],
      releaseGateSelectedReports: [{ id: "syncReadiness", selectedFile: "20260624-sync-readiness.json" }],
      installedRuntimeEvidence: {
        satisfied: true,
        sourceFileCount: 2,
        installedRuntimeFileCount: 2,
        sourceFingerprint: "abc123",
        installedRuntimeFingerprint: "abc123",
        missingSourceFiles: [],
        missingInstalledRuntimeFiles: [],
        mismatchedRuntimeFiles: [],
      },
    }]), "utf8");

    const result = spawnSync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      resolve(root, "scripts", "test-anticodex-diagnostics.ps1"),
      "-VerifyReportsSummary",
      summaryPath,
    ], { encoding: "utf8", windowsHide: true, timeout: 15000 });
    assert.equal(result.status, 1, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, false);
    assert.ok(payload.failures.includes("release-gates missing required gate postVerification missing failure reason details"));
    assert.equal(payload.diagnostics, null);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("diagnostics reports-summary fixture rejects missing required gates without guidance", () => {
  const tempRoot = mkdtempSync(join(os.tmpdir(), "anticodex-diagnostics-required-guidance-summary-"));
  try {
    const summaryPath = join(tempRoot, "reports-summary.json");
    writeFileSync(summaryPath, JSON.stringify([{
      file: "latest-release-gates.json",
      ok: false,
      shortReady: false,
      releaseReady: false,
      effectiveOk: false,
      strictOptionalRealTraffic: false,
      optionalRealTrafficReady: false,
      optionalRealTrafficFailures: [],
      missingRequired: ["postVerification"],
      missingShort: [],
      missingOptional: [],
      damagedReports: [],
      releaseGateFailures: ["postVerification"],
      releaseGateFailureReasons: [{
        id: "postVerification",
        failureReasons: ["stale_report"],
        failureReasonsAvailableCount: 1,
        failureReasonsHiddenCount: 0,
        reportFailureSamples: ["stale post-verification"],
        reportFailureSampleCodes: ["stale_report"],
        guidance: "",
        orderedActions: [],
      }],
      nextActions: [{
        id: "postVerification",
        command: "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\test-anticodex-post-verification.ps1 -TimeoutMinutes 10",
        reason: "stale_report",
        guidance: "real_traffic_evidence_stale: requires explicit user approval.",
        requiresGatewayStart: true,
        requiresRealTraffic: true,
        highImpact: true,
        blockedUntilExplicitUserApproval: true,
      }],
      nextActionsAvailableCount: 1,
      nextActionsHiddenCount: 0,
      nextActionsTruncated: false,
      approvalPlan: {
        actionCount: 1,
        blockedCount: 1,
        requiresGatewayStartCount: 1,
        requiresRealTrafficCount: 1,
        highImpactCount: 1,
        reportOnlyCount: 0,
        firstBlockedAction: "postVerification",
      },
      releaseGateGroups: [],
      releaseGateSelectedReports: [{ id: "syncReadiness", selectedFile: "20260624-sync-readiness.json" }],
      installedRuntimeEvidence: {
        satisfied: true,
        sourceFileCount: 2,
        installedRuntimeFileCount: 2,
        sourceFingerprint: "abc123",
        installedRuntimeFingerprint: "abc123",
        missingSourceFiles: [],
        missingInstalledRuntimeFiles: [],
        mismatchedRuntimeFiles: [],
      },
    }]), "utf8");

    const result = spawnSync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      resolve(root, "scripts", "test-anticodex-diagnostics.ps1"),
      "-VerifyReportsSummary",
      summaryPath,
    ], { encoding: "utf8", windowsHide: true, timeout: 15000 });
    assert.equal(result.status, 1, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, false);
    assert.ok(payload.failures.includes("release-gates missing required gate postVerification missing guidance"));
    assert.equal(payload.diagnostics, null);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("diagnostics reports-summary fixture rejects missing short gates without details", () => {
  const tempRoot = mkdtempSync(join(os.tmpdir(), "anticodex-diagnostics-short-detail-summary-"));
  try {
    const summaryPath = join(tempRoot, "reports-summary.json");
    writeFileSync(summaryPath, JSON.stringify([{
      file: "latest-release-gates.json",
      ok: false,
      shortReady: false,
      releaseReady: false,
      effectiveOk: false,
      strictOptionalRealTraffic: false,
      optionalRealTrafficReady: true,
      optionalRealTrafficFailures: [],
      missingRequired: [],
      missingShort: ["managerRealButtons"],
      missingOptional: [],
      damagedReports: [],
      releaseGateFailures: [],
      releaseGateFailureReasons: [],
      nextActions: [],
      approvalPlan: {
        actionCount: 0,
        blockedCount: 0,
        requiresGatewayStartCount: 0,
        requiresRealTrafficCount: 0,
        highImpactCount: 0,
        reportOnlyCount: 0,
        firstBlockedAction: "",
      },
      releaseGateGroups: [],
      releaseGateSelectedReports: [{ id: "syncReadiness", selectedFile: "20260624-sync-readiness.json" }],
      installedRuntimeEvidence: {
        satisfied: true,
        sourceFileCount: 2,
        installedRuntimeFileCount: 2,
        sourceFingerprint: "abc123",
        installedRuntimeFingerprint: "abc123",
        missingSourceFiles: [],
        missingInstalledRuntimeFiles: [],
        mismatchedRuntimeFiles: [],
      },
    }]), "utf8");

    const result = spawnSync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      resolve(root, "scripts", "test-anticodex-diagnostics.ps1"),
      "-VerifyReportsSummary",
      summaryPath,
    ], { encoding: "utf8", windowsHide: true, timeout: 15000 });
    assert.equal(result.status, 1, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, false);
    assert.ok(payload.failures.includes("release-gates missing short gate managerRealButtons missing failure reason details"));
    assert.equal(payload.diagnostics, null);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("diagnostics reports-summary fixture rejects missing short gates without next actions", () => {
  const tempRoot = mkdtempSync(join(os.tmpdir(), "anticodex-diagnostics-short-action-summary-"));
  try {
    const summaryPath = join(tempRoot, "reports-summary.json");
    writeFileSync(summaryPath, JSON.stringify([{
      file: "latest-release-gates.json",
      ok: false,
      shortReady: false,
      releaseReady: false,
      effectiveOk: false,
      strictOptionalRealTraffic: false,
      optionalRealTrafficReady: true,
      optionalRealTrafficFailures: [],
      missingRequired: [],
      missingShort: ["pluginCapabilities"],
      missingOptional: [],
      damagedReports: [],
      releaseGateFailures: ["pluginCapabilities"],
      releaseGateFailureReasons: [{
        id: "pluginCapabilities",
        failureReasons: ["ok_false"],
        failureReasonsAvailableCount: 1,
        failureReasonsHiddenCount: 0,
        reportFailureSamples: ["local gateway offline"],
        reportFailureSampleCodes: ["local_gateway_offline"],
        guidance: "local_gateway_offline: start or restore the local Anti-Codex gateway, then rerun plugin/app capability check.",
        orderedActions: [],
      }],
      nextActions: [],
      nextActionsAvailableCount: 0,
      nextActionsHiddenCount: 0,
      nextActionsTruncated: false,
      approvalPlan: {
        actionCount: 0,
        blockedCount: 0,
        requiresGatewayStartCount: 0,
        requiresRealTrafficCount: 0,
        highImpactCount: 0,
        reportOnlyCount: 0,
        firstBlockedAction: "",
        phases: [],
      },
      releaseGateGroups: [],
      releaseGateSelectedReports: [{ id: "syncReadiness", selectedFile: "20260624-sync-readiness.json" }],
      installedRuntimeEvidence: {
        satisfied: true,
        sourceFileCount: 2,
        installedRuntimeFileCount: 2,
        sourceFingerprint: "abc123",
        installedRuntimeFingerprint: "abc123",
        missingSourceFiles: [],
        missingInstalledRuntimeFiles: [],
        mismatchedRuntimeFiles: [],
      },
    }]), "utf8");

    const result = spawnSync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      resolve(root, "scripts", "test-anticodex-diagnostics.ps1"),
      "-VerifyReportsSummary",
      summaryPath,
    ], { encoding: "utf8", windowsHide: true, timeout: 15000 });
    assert.equal(result.status, 1, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, false);
    assert.ok(payload.failures.includes("release-gates missing short gate pluginCapabilities missing next action"));
    assert.equal(payload.diagnostics, null);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("diagnostics reports-summary fixture rejects missing optional gates without details", () => {
  const tempRoot = mkdtempSync(join(os.tmpdir(), "anticodex-diagnostics-optional-detail-summary-"));
  try {
    const summaryPath = join(tempRoot, "reports-summary.json");
    writeFileSync(summaryPath, JSON.stringify([{
      file: "latest-release-gates.json",
      ok: true,
      shortReady: true,
      releaseReady: true,
      effectiveOk: true,
      strictOptionalRealTraffic: false,
      optionalRealTrafficReady: true,
      optionalRealTrafficFailures: [],
      missingRequired: [],
      missingShort: [],
      missingOptional: ["coldRelaunch"],
      damagedReports: [],
      releaseGateFailures: [],
      releaseGateFailureReasons: [],
      nextActions: [],
      approvalPlan: {
        actionCount: 0,
        blockedCount: 0,
        requiresGatewayStartCount: 0,
        requiresRealTrafficCount: 0,
        highImpactCount: 0,
        reportOnlyCount: 0,
        firstBlockedAction: "",
      },
      releaseGateGroups: [],
      releaseGateSelectedReports: [{ id: "syncReadiness", selectedFile: "20260624-sync-readiness.json" }],
      installedRuntimeEvidence: {
        satisfied: true,
        sourceFileCount: 2,
        installedRuntimeFileCount: 2,
        sourceFingerprint: "abc123",
        installedRuntimeFingerprint: "abc123",
        missingSourceFiles: [],
        missingInstalledRuntimeFiles: [],
        mismatchedRuntimeFiles: [],
      },
    }]), "utf8");

    const result = spawnSync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      resolve(root, "scripts", "test-anticodex-diagnostics.ps1"),
      "-VerifyReportsSummary",
      summaryPath,
    ], { encoding: "utf8", windowsHide: true, timeout: 15000 });
    assert.equal(result.status, 1, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, false);
    assert.ok(payload.failures.includes("release-gates missing optional gate coldRelaunch missing failure reason details"));
    assert.equal(payload.diagnostics, null);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("diagnostics reports-summary fixture rejects short and optional gates without guidance", () => {
  const tempRoot = mkdtempSync(join(os.tmpdir(), "anticodex-diagnostics-short-optional-guidance-summary-"));
  try {
    const summaryPath = join(tempRoot, "reports-summary.json");
    writeFileSync(summaryPath, JSON.stringify([{
      file: "latest-release-gates.json",
      ok: false,
      shortReady: false,
      releaseReady: false,
      effectiveOk: false,
      strictOptionalRealTraffic: false,
      optionalRealTrafficReady: false,
      optionalRealTrafficFailures: [],
      missingRequired: [],
      missingShort: ["managerRealButtons"],
      missingOptional: ["coldRelaunch"],
      damagedReports: [],
      releaseGateFailures: ["managerRealButtons", "coldRelaunch"],
      releaseGateFailureReasons: [{
        id: "managerRealButtons",
        failureReasons: ["stale_report"],
        failureReasonsAvailableCount: 1,
        failureReasonsHiddenCount: 0,
        reportFailureSamples: ["stale manager button report"],
        reportFailureSampleCodes: ["stale_report"],
        guidance: "",
        orderedActions: [],
      }, {
        id: "coldRelaunch",
        failureReasons: ["missing_report"],
        failureReasonsAvailableCount: 1,
        failureReasonsHiddenCount: 0,
        reportFailureSamples: ["missing cold relaunch report"],
        reportFailureSampleCodes: ["missing_report"],
        guidance: "",
        orderedActions: [],
      }],
      nextActions: [{
        id: "managerRealButtons",
        command: "node scripts/test-anticodex-release-gates.mjs --strict --compact",
        reason: "stale_report",
        guidance: "report-only: inspect release gate evidence before rerunning Manager checks.",
        reportOnly: true,
      }],
      nextActionsAvailableCount: 1,
      nextActionsHiddenCount: 0,
      nextActionsTruncated: false,
      approvalPlan: {
        actionCount: 1,
        blockedCount: 0,
        requiresGatewayStartCount: 0,
        requiresRealTrafficCount: 0,
        highImpactCount: 0,
        reportOnlyCount: 1,
        firstBlockedAction: "",
        phases: [{
          id: "report-only",
          actionCount: 1,
          reportOnly: true,
          requiresGatewayStart: false,
          requiresRealTraffic: false,
          highImpact: false,
          blocked: false,
        }],
      },
      releaseGateGroups: [],
      releaseGateSelectedReports: [{ id: "syncReadiness", selectedFile: "20260624-sync-readiness.json" }],
      installedRuntimeEvidence: {
        satisfied: true,
        sourceFileCount: 2,
        installedRuntimeFileCount: 2,
        sourceFingerprint: "abc123",
        installedRuntimeFingerprint: "abc123",
        missingSourceFiles: [],
        missingInstalledRuntimeFiles: [],
        mismatchedRuntimeFiles: [],
      },
    }]), "utf8");

    const result = spawnSync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      resolve(root, "scripts", "test-anticodex-diagnostics.ps1"),
      "-VerifyReportsSummary",
      summaryPath,
    ], { encoding: "utf8", windowsHide: true, timeout: 15000 });
    assert.equal(result.status, 1, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, false);
    assert.ok(payload.failures.includes("release-gates missing short gate managerRealButtons missing guidance"));
    assert.ok(payload.failures.includes("release-gates missing optional gate coldRelaunch missing guidance"));
    assert.equal(payload.diagnostics, null);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("diagnostics reports-summary fixture rejects missing gates without required markers", () => {
  const tempRoot = mkdtempSync(join(os.tmpdir(), "anticodex-diagnostics-missing-gate-marker-summary-"));
  try {
    const summaryPath = join(tempRoot, "reports-summary.json");
    writeFileSync(summaryPath, JSON.stringify([{
      file: "latest-release-gates.json",
      ok: false,
      shortReady: false,
      releaseReady: false,
      effectiveOk: false,
      strictOptionalRealTraffic: false,
      optionalRealTrafficReady: false,
      optionalRealTrafficFailures: [],
      missingRequired: ["pluginCapabilities"],
      missingShort: ["pluginCapabilities"],
      missingOptional: ["coldRelaunch"],
      damagedReports: [],
      releaseGateFailures: ["pluginCapabilities", "coldRelaunch"],
      releaseGateFailureReasons: [{
        id: "pluginCapabilities",
        failureReasons: ["ok_false"],
        failureReasonsAvailableCount: 1,
        failureReasonsHiddenCount: 0,
        reportFailureSamples: ["local gateway offline"],
        reportFailureSampleCodes: ["local_gateway_offline"],
        guidance: "local_gateway_offline: start or restore the local Anti-Codex gateway.",
        orderedActions: [],
      }, {
        id: "coldRelaunch",
        failureReasons: ["missing_report"],
        failureReasonsAvailableCount: 1,
        failureReasonsHiddenCount: 0,
        reportFailureSamples: ["missing cold relaunch report"],
        reportFailureSampleCodes: ["missing_report"],
        guidance: "optional_cold_relaunch_required: run only with explicit approval.",
        orderedActions: [],
      }],
      nextActions: [{
        id: "pluginCapabilities",
        command: "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\test-anticodex-plugin-capabilities.ps1 -TimeoutSec 45",
        reason: "ok_false",
        guidance: "local_gateway_offline: start or restore the local Anti-Codex gateway.",
        requiresGatewayStart: true,
        requiresRealTraffic: false,
        highImpact: false,
        requiredForShort: true,
        requiredForRelease: true,
        blockedUntilExplicitUserApproval: true,
      }],
      nextActionsAvailableCount: 1,
      nextActionsHiddenCount: 0,
      nextActionsTruncated: false,
      approvalPlan: {
        actionCount: 1,
        blockedCount: 1,
        requiresGatewayStartCount: 1,
        requiresRealTrafficCount: 0,
        highImpactCount: 0,
        reportOnlyCount: 0,
        requiredForShortCount: 1,
        requiredForReleaseCount: 1,
        firstBlockedAction: "pluginCapabilities",
        phases: [],
      },
      releaseGateGroups: [],
      releaseGateSelectedReports: [{ id: "syncReadiness", selectedFile: "20260624-sync-readiness.json" }],
      installedRuntimeEvidence: {
        satisfied: true,
        sourceFileCount: 2,
        installedRuntimeFileCount: 2,
        sourceFingerprint: "abc123",
        installedRuntimeFingerprint: "abc123",
        missingSourceFiles: [],
        missingInstalledRuntimeFiles: [],
        mismatchedRuntimeFiles: [],
      },
    }]), "utf8");

    const result = spawnSync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      resolve(root, "scripts", "test-anticodex-diagnostics.ps1"),
      "-VerifyReportsSummary",
      summaryPath,
    ], { encoding: "utf8", windowsHide: true, timeout: 15000 });
    assert.equal(result.status, 1, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, false);
    assert.ok(payload.failures.includes("release-gates missing required gate pluginCapabilities missing required-for-release marker"));
    assert.ok(payload.failures.includes("release-gates missing short gate pluginCapabilities missing required-for-short marker"));
    assert.ok(payload.failures.includes("release-gates missing optional gate coldRelaunch missing optional marker"));
    assert.equal(payload.diagnostics, null);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("diagnostics reports-summary fixture rejects group missing gates without aligned details", () => {
  const tempRoot = mkdtempSync(join(os.tmpdir(), "anticodex-diagnostics-group-missing-summary-"));
  try {
    const summaryPath = join(tempRoot, "reports-summary.json");
    writeFileSync(summaryPath, JSON.stringify([{
      file: "latest-release-gates.json",
      ok: false,
      shortReady: false,
      releaseReady: false,
      effectiveOk: false,
      strictOptionalRealTraffic: false,
      optionalRealTrafficReady: true,
      optionalRealTrafficFailures: [],
      missingRequired: [],
      missingShort: [],
      missingOptional: [],
      damagedReports: [],
      releaseGateFailures: [],
      releaseGateFailureReasons: [],
      releaseGateGroups: [{
        group: "real-traffic",
        missingRequired: ["postVerification"],
        missingOptional: ["coldRelaunch"],
      }],
      nextActions: [],
      approvalPlan: {
        actionCount: 0,
        blockedCount: 0,
        requiresGatewayStartCount: 0,
        requiresRealTrafficCount: 0,
        highImpactCount: 0,
        reportOnlyCount: 0,
        firstBlockedAction: "",
      },
      releaseGateSelectedReports: [{ id: "syncReadiness", selectedFile: "20260624-sync-readiness.json" }],
      installedRuntimeEvidence: {
        satisfied: true,
        sourceFileCount: 2,
        installedRuntimeFileCount: 2,
        sourceFingerprint: "abc123",
        installedRuntimeFingerprint: "abc123",
        missingSourceFiles: [],
        missingInstalledRuntimeFiles: [],
        mismatchedRuntimeFiles: [],
      },
    }]), "utf8");

    const result = spawnSync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      resolve(root, "scripts", "test-anticodex-diagnostics.ps1"),
      "-VerifyReportsSummary",
      summaryPath,
    ], { encoding: "utf8", windowsHide: true, timeout: 15000 });
    assert.equal(result.status, 1, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, false);
    assert.ok(payload.failures.includes("release-gates group real-traffic missing required gate postVerification absent from top-level missingRequired"));
    assert.ok(payload.failures.includes("release-gates group real-traffic missing required gate postVerification missing failure reason details"));
    assert.ok(payload.failures.includes("release-gates group real-traffic missing required gate postVerification has no next action"));
    assert.ok(payload.failures.includes("release-gates group real-traffic missing optional gate coldRelaunch absent from top-level missingOptional"));
    assert.ok(payload.failures.includes("release-gates group real-traffic missing optional gate coldRelaunch missing failure reason details"));
    assert.ok(payload.failures.includes("release-gates group real-traffic missing total count"));
    assert.equal(payload.diagnostics, null);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("diagnostics reports-summary fixture rejects selected history without mtime", () => {
  const tempRoot = mkdtempSync(join(os.tmpdir(), "anticodex-diagnostics-selected-history-mtime-summary-"));
  try {
    const summaryPath = join(tempRoot, "reports-summary.json");
    writeFileSync(summaryPath, JSON.stringify([{
      file: "latest-release-gates.json",
      ok: false,
      shortReady: true,
      releaseReady: false,
      effectiveOk: false,
      strictOptionalRealTraffic: false,
      optionalRealTrafficReady: true,
      optionalRealTrafficFailures: [],
      missingRequired: [],
      missingShort: [],
      missingOptional: [],
      damagedReports: [],
      releaseGateFailures: ["syncReadiness"],
      releaseGateFailureReasons: [{
        id: "syncReadiness",
        group: "no-traffic",
        failureReasons: ["selected_history"],
        failureReasonsAvailableCount: 1,
        failureReasonsHiddenCount: 0,
        reportFailureSamples: ["latest report was fast; selected full history report"],
        reportFailureSampleCodes: ["selected_history"],
        guidance: "host_sync_required: inspect sync-readiness history before host sync approval.",
        selectedFromHistory: true,
        selectedFile: "20260624-sync-readiness.json",
        selectedMtime: "2026-06-24T00:00:00.000Z",
        orderedActions: [],
      }],
      nextActions: [],
      nextActionsAvailableCount: 0,
      nextActionsHiddenCount: 0,
      nextActionsTruncated: false,
      approvalPlan: {
        actionCount: 0,
        blockedCount: 0,
        requiresGatewayStartCount: 0,
        requiresRealTrafficCount: 0,
        highImpactCount: 0,
        reportOnlyCount: 0,
        firstBlockedAction: "",
        phases: [],
      },
      releaseGateGroups: [],
      releaseGateSelectedReports: [{ id: "syncReadiness", group: "no-traffic", selectedFile: "20260624-sync-readiness.json" }],
      installedRuntimeEvidence: {
        satisfied: true,
        sourceFileCount: 2,
        installedRuntimeFileCount: 2,
        sourceFingerprint: "abc123",
        installedRuntimeFingerprint: "abc123",
        missingSourceFiles: [],
        missingInstalledRuntimeFiles: [],
        mismatchedRuntimeFiles: [],
      },
    }]), "utf8");

    const result = spawnSync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      resolve(root, "scripts", "test-anticodex-diagnostics.ps1"),
      "-VerifyReportsSummary",
      summaryPath,
    ], { encoding: "utf8", windowsHide: true, timeout: 15000 });
    assert.equal(result.status, 1, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, false);
    assert.ok(payload.failures.includes("release-gates selected history gate syncReadiness missing selected report mtime"));
    assert.equal(payload.diagnostics, null);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("diagnostics reports-summary fixture rejects semantic failures without report-only action", () => {
  const tempRoot = mkdtempSync(join(os.tmpdir(), "anticodex-diagnostics-report-only-summary-"));
  try {
    const summaryPath = join(tempRoot, "reports-summary.json");
    writeFileSync(summaryPath, JSON.stringify([{
      file: "latest-release-gates.json",
      ok: false,
      shortReady: false,
      releaseReady: false,
      effectiveOk: false,
      strictOptionalRealTraffic: false,
      optionalRealTrafficReady: false,
      optionalRealTrafficFailures: [],
      missingRequired: ["postVerification"],
      missingShort: [],
      missingOptional: [],
      damagedReports: [],
      releaseGateFailures: ["postVerification"],
      releaseGateFailureReasons: [{
        id: "postVerification",
        failureReasons: ["semantic_failures"],
        reportFailureSamples: ["missing final proof"],
        reportFailureSampleCodes: ["semantic_failures"],
      }],
      nextActions: [{
        id: "postVerification",
        command: "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\test-anticodex-post-verification.ps1 -TimeoutMinutes 10",
        requiresGatewayStart: true,
        requiresRealTraffic: true,
        highImpact: true,
        blockedUntilExplicitUserApproval: true,
      }],
      approvalPlan: {
        actionCount: 1,
        blockedCount: 1,
        requiresGatewayStartCount: 1,
        requiresRealTrafficCount: 1,
        highImpactCount: 1,
        reportOnlyCount: 2,
        firstBlockedAction: "postVerification",
      },
      releaseGateGroups: [],
      releaseGateSelectedReports: [{ id: "syncReadiness", selectedFile: "20260624-sync-readiness.json" }],
      installedRuntimeEvidence: {
        satisfied: true,
        sourceFileCount: 2,
        installedRuntimeFileCount: 2,
        sourceFingerprint: "abc123",
        installedRuntimeFingerprint: "abc123",
        missingSourceFiles: [],
        missingInstalledRuntimeFiles: [],
        mismatchedRuntimeFiles: [],
      },
    }]), "utf8");

    const result = spawnSync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      resolve(root, "scripts", "test-anticodex-diagnostics.ps1"),
      "-VerifyReportsSummary",
      summaryPath,
    ], { encoding: "utf8", windowsHide: true, timeout: 15000 });
    assert.equal(result.status, 1, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, false);
    assert.ok(payload.failures.includes("release-gates semantic failures missing report-only next action"));
    assert.ok(payload.failures.includes("release-gates approval plan report-only action count mismatch"));
    assert.equal(payload.diagnostics, null);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("diagnostics reports-summary fixture rejects semantic failures without reason marker", () => {
  const tempRoot = mkdtempSync(join(os.tmpdir(), "anticodex-diagnostics-semantic-marker-summary-"));
  try {
    const summaryPath = join(tempRoot, "reports-summary.json");
    writeFileSync(summaryPath, JSON.stringify([minimalDiagnosticsReleaseGateSummary({
      releaseReady: false,
      effectiveOk: false,
      releaseGateFailures: [{
        id: "sourcePreflight",
        semanticFailures: ["source_preflight_public_documentation"],
        semanticFailuresAvailableCount: 1,
        semanticFailuresHiddenCount: 0,
      }],
      releaseGateFailureReasons: [{
        id: "sourcePreflight",
        requiredForShort: true,
        requiredForRelease: true,
        failureReasons: ["ok_false"],
        failureReasonsAvailableCount: 1,
        failureReasonsHiddenCount: 0,
        guidance: "releaseGateReportOnlyCheck: inspect release-gate semantic evidence before rerunning.",
        orderedActions: [],
      }],
      nextActions: [],
      approvalPlan: {
        actionCount: 0,
        blockedCount: 0,
        requiresGatewayStartCount: 0,
        requiresRealTrafficCount: 0,
        highImpactCount: 0,
        reportOnlyCount: 0,
        requiredForShortCount: 0,
        requiredForReleaseCount: 0,
        firstBlockedAction: "",
        phases: [],
      },
    })]), "utf8");

    const result = spawnSync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      resolve(root, "scripts", "test-anticodex-diagnostics.ps1"),
      "-VerifyReportsSummary",
      summaryPath,
    ], { encoding: "utf8", windowsHide: true, timeout: 15000 });
    assert.equal(result.status, 1, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, false);
    assert.ok(payload.failures.includes("release-gates failure sourcePreflight missing semantic failure reason marker"));
    assert.ok(payload.failures.includes("release-gates semantic failures missing report-only next action"));
    assert.equal(payload.diagnostics, null);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("diagnostics reports-summary fixture rejects report-only phase mismatches", () => {
  const tempRoot = mkdtempSync(join(os.tmpdir(), "anticodex-diagnostics-report-only-phase-summary-"));
  try {
    const summaryPath = join(tempRoot, "reports-summary.json");
    writeFileSync(summaryPath, JSON.stringify([{
      file: "latest-release-gates.json",
      ok: false,
      shortReady: false,
      releaseReady: false,
      effectiveOk: false,
      strictOptionalRealTraffic: false,
      optionalRealTrafficReady: false,
      optionalRealTrafficFailures: [],
      missingRequired: ["postVerification"],
      missingShort: [],
      missingOptional: [],
      damagedReports: [],
      releaseGateFailures: ["postVerification"],
      releaseGateFailureReasons: [{
        id: "postVerification",
        failureReasons: ["semantic_failures"],
        reportFailureSamples: ["missing final proof"],
        reportFailureSampleCodes: ["semantic_failures"],
      }],
      nextActions: [{
        id: "releaseGateReportOnlyCheck",
        command: "node scripts/test-anticodex-release-gates.mjs --strict",
        phase: "report-only",
        reason: "semantic_failures",
        guidance: "review release-gate semantic failures before running gateway or real-traffic checks",
        reportOnly: true,
        requiresGatewayStart: false,
        requiresRealTraffic: false,
        highImpact: false,
        blockedUntilExplicitUserApproval: false,
      }, {
        id: "postVerification",
        command: "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\test-anticodex-post-verification.ps1 -TimeoutMinutes 10",
        reason: "semantic_failures",
        guidance: "real_traffic_evidence_stale: rerun post verification after approval.",
        requiresGatewayStart: true,
        requiresRealTraffic: true,
        highImpact: true,
        blockedUntilExplicitUserApproval: true,
      }],
      approvalPlan: {
        actionCount: 2,
        blockedCount: 1,
        requiresGatewayStartCount: 1,
        requiresRealTrafficCount: 1,
        highImpactCount: 1,
        reportOnlyCount: 1,
        firstBlockedAction: "postVerification",
        phases: [{
          phase: "report-only",
          count: 1,
          reportOnly: false,
        }],
      },
      releaseGateGroups: [],
      releaseGateSelectedReports: [{ id: "syncReadiness", selectedFile: "20260624-sync-readiness.json" }],
      installedRuntimeEvidence: {
        satisfied: true,
        sourceFileCount: 2,
        installedRuntimeFileCount: 2,
        sourceFingerprint: "abc123",
        installedRuntimeFingerprint: "abc123",
        missingSourceFiles: [],
        missingInstalledRuntimeFiles: [],
        mismatchedRuntimeFiles: [],
      },
    }]), "utf8");

    const result = spawnSync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      resolve(root, "scripts", "test-anticodex-diagnostics.ps1"),
      "-VerifyReportsSummary",
      summaryPath,
    ], { encoding: "utf8", windowsHide: true, timeout: 15000 });
    assert.equal(result.status, 1, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, false);
    assert.ok(payload.failures.includes("release-gates approval plan report-only phase mismatch"));
    assert.equal(payload.diagnostics, null);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("diagnostics reports-summary fixture rejects report-only actions without reason guidance", () => {
  const tempRoot = mkdtempSync(join(os.tmpdir(), "anticodex-diagnostics-report-only-guidance-"));
  try {
    const summaryPath = join(tempRoot, "reports-summary.json");
    writeFileSync(summaryPath, JSON.stringify([{
      file: "latest-release-gates.json",
      ok: false,
      shortReady: false,
      releaseReady: false,
      effectiveOk: false,
      strictOptionalRealTraffic: false,
      optionalRealTrafficReady: false,
      optionalRealTrafficFailures: [],
      missingRequired: [],
      missingShort: [],
      missingOptional: [],
      damagedReports: [],
      releaseGateFailures: ["sourcePreflight"],
      releaseGateFailureReasons: [{
        id: "sourcePreflight",
        failureReasons: ["semantic_failures"],
        reportFailureSamples: ["public docs evidence missing"],
        reportFailureSampleCodes: ["source_preflight_public_documentation"],
        guidance: "review release-gate semantic failures before rerunning source preflight",
        orderedActions: [],
      }],
      nextActions: [{
        id: "releaseGateReportOnlyCheck",
        command: "node scripts/test-anticodex-release-gates.mjs --strict",
        phase: "report-only",
        reportOnly: true,
        requiresGatewayStart: false,
        requiresRealTraffic: false,
        highImpact: false,
        blockedUntilExplicitUserApproval: false,
      }],
      approvalPlan: {
        actionCount: 1,
        blockedCount: 0,
        requiresGatewayStartCount: 0,
        requiresRealTrafficCount: 0,
        highImpactCount: 0,
        reportOnlyCount: 1,
        phases: [{
          phase: "report-only",
          count: 1,
          reportOnly: true,
        }],
      },
      releaseGateGroups: [],
      releaseGateSelectedReports: [{ id: "syncReadiness", selectedFile: "20260624-sync-readiness.json" }],
      installedRuntimeEvidence: {
        satisfied: true,
        sourceFileCount: 2,
        installedRuntimeFileCount: 2,
        sourceFingerprint: "abc123",
        installedRuntimeFingerprint: "abc123",
        missingSourceFiles: [],
        missingInstalledRuntimeFiles: [],
        mismatchedRuntimeFiles: [],
      },
    }]), "utf8");

    const result = spawnSync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      resolve(root, "scripts", "test-anticodex-diagnostics.ps1"),
      "-VerifyReportsSummary",
      summaryPath,
    ], { encoding: "utf8", windowsHide: true, timeout: 15000 });
    assert.equal(result.status, 1, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, false);
    assert.ok(payload.failures.includes("release-gates next action releaseGateReportOnlyCheck missing guidance"));
    assert.ok(payload.failures.includes("release-gates next action releaseGateReportOnlyCheck missing reason"));
    assert.equal(payload.diagnostics, null);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("diagnostics reports-summary fixture rejects overcounted approval plan risk fields", () => {
  const tempRoot = mkdtempSync(join(os.tmpdir(), "anticodex-diagnostics-plan-overcount-summary-"));
  try {
    const summaryPath = join(tempRoot, "reports-summary.json");
    writeFileSync(summaryPath, JSON.stringify([{
      file: "latest-release-gates.json",
      ok: false,
      shortReady: false,
      releaseReady: false,
      effectiveOk: false,
      strictOptionalRealTraffic: false,
      optionalRealTrafficReady: true,
      optionalRealTrafficFailures: [],
      missingRequired: ["pluginCapabilities"],
      missingShort: ["pluginCapabilities"],
      missingOptional: [],
      damagedReports: [],
      releaseGateFailures: ["pluginCapabilities"],
      releaseGateFailureReasons: [{
        id: "pluginCapabilities",
        reportFailureSamples: ["health request failed"],
        reportFailureSampleCodes: ["local_gateway_offline"],
        offlineSnapshotEvidence: {
          connectorContentMatches: true,
          appToolContentMatches: true,
          refreshGateSatisfied: true,
          refreshSelectedFile: "latest-refresh-features.json",
        },
      }],
      nextActions: [{
        id: "pluginCapabilities",
        phase: "plugin-capabilities",
        command: "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\test-anticodex-plugin-capabilities.ps1 -TimeoutSec 45",
        requiresGatewayStart: true,
        requiresRealTraffic: false,
        highImpact: false,
        reportOnly: false,
        requiredForShort: false,
        requiredForRelease: false,
        blockedUntilExplicitUserApproval: true,
      }],
      approvalPlan: {
        actionCount: 1,
        blockedCount: 2,
        requiresGatewayStartCount: 2,
        requiresRealTrafficCount: 2,
        highImpactCount: 2,
        reportOnlyCount: 0,
        requiredForShortCount: 2,
        requiredForReleaseCount: 2,
        firstBlockedAction: "pluginCapabilities",
        phases: [{
          phase: "plugin-capabilities",
          count: 2,
          requiresGatewayStart: false,
          requiresRealTraffic: true,
          highImpact: true,
          reportOnly: false,
          blockedUntilExplicitUserApproval: false,
        }],
      },
      releaseGateGroups: [],
      releaseGateSelectedReports: [{ id: "syncReadiness", selectedFile: "20260624-sync-readiness.json" }],
      installedRuntimeEvidence: {
        satisfied: true,
        sourceFileCount: 2,
        installedRuntimeFileCount: 2,
        sourceFingerprint: "abc123",
        installedRuntimeFingerprint: "abc123",
        missingSourceFiles: [],
        missingInstalledRuntimeFiles: [],
        mismatchedRuntimeFiles: [],
      },
    }]), "utf8");

    const result = spawnSync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      resolve(root, "scripts", "test-anticodex-diagnostics.ps1"),
      "-VerifyReportsSummary",
      summaryPath,
    ], { encoding: "utf8", windowsHide: true, timeout: 15000 });
    assert.equal(result.status, 1, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, false);
    assert.ok(payload.failures.includes("release-gates approval plan overcounts gateway actions"));
    assert.ok(payload.failures.includes("release-gates approval plan overcounts real-traffic actions"));
    assert.ok(payload.failures.includes("release-gates approval plan overcounts high-impact actions"));
    assert.ok(payload.failures.includes("release-gates approval plan overcounts required-for-short actions"));
    assert.ok(payload.failures.includes("release-gates approval plan overcounts required-for-release actions"));
    assert.ok(payload.failures.includes("release-gates approval plan phase plugin-capabilities count mismatch"));
    assert.ok(payload.failures.includes("release-gates approval plan phase plugin-capabilities blocked mismatch"));
    assert.equal(payload.diagnostics, null);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("diagnostics reports-summary fixture rejects incomplete approval plan counts", () => {
  const tempRoot = mkdtempSync(join(os.tmpdir(), "anticodex-diagnostics-plan-summary-"));
  try {
    const summaryPath = join(tempRoot, "reports-summary.json");
    writeFileSync(summaryPath, JSON.stringify([{
      file: "latest-release-gates.json",
      ok: false,
      shortReady: false,
      releaseReady: false,
      effectiveOk: false,
      strictOptionalRealTraffic: false,
      optionalRealTrafficReady: false,
      optionalRealTrafficFailures: [],
      missingRequired: ["pluginCapabilities"],
      missingShort: ["pluginCapabilities"],
      missingOptional: [],
      damagedReports: [],
      releaseGateFailures: ["pluginCapabilities"],
      releaseGateFailureReasons: [],
      nextActions: [{
        id: "pluginCapabilities",
        command: "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\test-anticodex-plugin-capabilities.ps1 -TimeoutSec 45",
        requiresGatewayStart: true,
        requiresRealTraffic: false,
        highImpact: false,
        requiredForShort: true,
        requiredForRelease: true,
        blockedUntilExplicitUserApproval: true,
      }],
      approvalPlan: {
        actionCount: 1,
      },
      releaseGateGroups: [],
      releaseGateSelectedReports: [{ id: "syncReadiness", selectedFile: "20260624-sync-readiness.json" }],
      installedRuntimeEvidence: {
        satisfied: true,
        sourceFileCount: 2,
        installedRuntimeFileCount: 2,
        sourceFingerprint: "abc123",
        installedRuntimeFingerprint: "abc123",
        missingSourceFiles: [],
        missingInstalledRuntimeFiles: [],
        mismatchedRuntimeFiles: [],
      },
    }]), "utf8");

    const result = spawnSync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      resolve(root, "scripts", "test-anticodex-diagnostics.ps1"),
      "-VerifyReportsSummary",
      summaryPath,
    ], { encoding: "utf8", windowsHide: true, timeout: 15000 });
    assert.equal(result.status, 1, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, false);
    assert.ok(payload.failures.includes("release-gates approval plan missing blocked count"));
    assert.ok(payload.failures.includes("release-gates approval plan missing gateway count"));
    assert.ok(payload.failures.includes("release-gates approval plan missing real-traffic count"));
    assert.ok(payload.failures.includes("release-gates approval plan missing high-impact count"));
    assert.ok(payload.failures.includes("release-gates approval plan missing report-only count"));
    assert.ok(payload.failures.includes("release-gates approval plan missing required-for-short count"));
    assert.ok(payload.failures.includes("release-gates approval plan missing required-for-release count"));
    assert.equal(payload.diagnostics, null);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("diagnostics reports-summary fixture rejects null approval plan counts", () => {
  const tempRoot = mkdtempSync(join(os.tmpdir(), "anticodex-diagnostics-null-plan-summary-"));
  try {
    const summaryPath = join(tempRoot, "reports-summary.json");
    writeFileSync(summaryPath, JSON.stringify([{
      file: "latest-release-gates.json",
      ok: true,
      shortReady: true,
      releaseReady: true,
      effectiveOk: true,
      strictOptionalRealTraffic: false,
      optionalRealTrafficReady: false,
      optionalRealTrafficFailures: [],
      missingRequired: [],
      missingShort: [],
      missingOptional: [],
      damagedReports: [],
      releaseGateFailures: [],
      releaseGateFailureReasons: [],
      nextActions: [],
      approvalPlan: {
        actionCount: null,
        blockedCount: null,
        requiresGatewayStartCount: null,
        requiresRealTrafficCount: null,
        highImpactCount: null,
        reportOnlyCount: null,
        requiredForShortCount: null,
        requiredForReleaseCount: null,
        firstBlockedAction: "",
      },
      releaseGateGroups: [],
      releaseGateSelectedReports: [{ id: "syncReadiness", selectedFile: "20260624-sync-readiness.json" }],
      installedRuntimeEvidence: {
        satisfied: true,
        sourceFileCount: 2,
        installedRuntimeFileCount: 2,
        sourceFingerprint: "abc123",
        installedRuntimeFingerprint: "abc123",
        missingSourceFiles: [],
        missingInstalledRuntimeFiles: [],
        mismatchedRuntimeFiles: [],
      },
    }]), "utf8");

    const result = spawnSync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      resolve(root, "scripts", "test-anticodex-diagnostics.ps1"),
      "-VerifyReportsSummary",
      summaryPath,
    ], { encoding: "utf8", windowsHide: true, timeout: 15000 });
    assert.equal(result.status, 1, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, false);
    assert.ok(payload.failures.includes("release-gates approval plan invalid action count"));
    assert.ok(payload.failures.includes("release-gates approval plan invalid blocked count"));
    assert.ok(payload.failures.includes("release-gates approval plan invalid gateway count"));
    assert.ok(payload.failures.includes("release-gates approval plan invalid real-traffic count"));
    assert.ok(payload.failures.includes("release-gates approval plan invalid high-impact count"));
    assert.ok(payload.failures.includes("release-gates approval plan invalid report-only count"));
    assert.ok(payload.failures.includes("release-gates approval plan invalid required-for-short count"));
    assert.ok(payload.failures.includes("release-gates approval plan invalid required-for-release count"));
    assert.equal(payload.diagnostics, null);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("Anti-Codex ships a passive release gate summary verifier", () => {
  const releaseGates = readFileSync(resolve(root, "scripts", "test-anticodex-release-gates.mjs"), "utf8");
  const server = readFileSync(resolve(root, "translator", "adaptive-server.mjs"), "utf8");
  const collector = readFileSync(resolve(root, "scripts", "collect-anticodex-diagnostics.ps1"), "utf8");
  const managerInject = readFileSync(resolve(root, "scripts", "anticodex-manager-inject.js"), "utf8");
  const managerBridge = readFileSync(resolve(root, "scripts", "anticodex-manager-bridge.mjs"), "utf8");
  const syncRuntime = readFileSync(resolve(root, "scripts", "sync-anticodex-runtime.ps1"), "utf8");
  const mcpProbe = readFileSync(resolve(root, "scripts", "probe-anticodex-worker-mcp-servers.mjs"), "utf8");
  const sourcePreflight = readFileSync(resolve(root, "scripts", "test-anticodex-source-preflight.ps1"), "utf8");
  const installedOverall = readFileSync(resolve(root, "scripts", "test-anticodex-installed-overall.ps1"), "utf8");
  const mjsVerifierPowerShellWrapper = /powershell(?:\.exe)?[\s\S]{0,240}(?:-File|-Command)[\s\S]{0,240}(?:test-anticodex-release-gates|summarize-anticodex-report)\.mjs/i;
  const releaseGateReportFiles = [...new Set([...releaseGates.matchAll(/file: "([^"]+\.json)"/g)].map((match) => match[1]))];
  const reportFilePattern = (file) => new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

  assert.match(releaseGates, /latest-release-gates\.json/);
  assert.match(releaseGates, /compactStatus = args\.has\("--compact-status"\) \|\| args\.has\("--status"\)/);
  assert.match(releaseGates, /function compactReleaseGateStatus\(payload\)/);
  assert.match(releaseGates, /reportName: "release-gates-status"/);
  assert.match(releaseGates, /firstBlockedAction/);
  assert.match(releaseGates, /compactStatus \? compactReleaseGateStatus\(payload\) : payload/);
  assert.match(releaseGates, /group: "short"/);
  assert.match(releaseGates, /group: "no-traffic"/);
  assert.match(releaseGates, /real-traffic/);
  assert.match(releaseGates, /group: "manager"/);
  assert.match(releaseGates, /group: "optional-real-traffic"/);
  assert.match(releaseGates, /group: "soak"/);
  assert.match(releaseGates, /requireStabilitySoakSemantics/);
  assert.match(releaseGates, /stability_soak_pid_not_stable/);
  assert.match(releaseGates, /stability_soak_health_checks_missing/);
  assert.match(releaseGates, /stability_soak_turn_not_ok/);
  assert.match(releaseGates, /group: "cold"/);
  assert.match(releaseGates, /latest-cold-relaunch\.json/);
  assert.match(releaseGates, /requiredForRelease: false/);
  assert.match(releaseGates, /requireColdRelaunchSemantics/);
  assert.match(releaseGates, /cold_relaunch_health_not_ready/);
  assert.match(releaseGates, /cold_relaunch_main_count/);
  assert.match(releaseGates, /cold_relaunch_original_codex_not_proven/);
  assert.match(releaseGates, /cold_relaunch_stage_missing/);
  assert.match(releaseGates, /Manual\/isolated restart evidence/);
  assert.doesNotMatch(releaseGates, /No latest report is produced/);
  assert.match(releaseGates, /requiredForShort/);
  assert.match(releaseGates, /requiredForRelease/);
  assert.match(releaseGates, /installed_overall_manager_verifier_lock_busy/);
  assert.match(releaseGates, /manager-verifier-lock-busy/);
  assert.match(releaseGates, /id: "nativeToolLoop"[\s\S]*requiredForRelease: false[\s\S]*Opt-in native bridge diagnostic/);
  assert.match(releaseGates, /id: "nativeMultiToolLoop"[\s\S]*requiredForRelease: false[\s\S]*Opt-in native bridge diagnostic/);
  assert.match(releaseGates, /nativeBridgeDisabledSkip/);
  assert.match(releaseGates, /native_bridge_disabled/);
  assert.match(releaseGates, /native-bridge-disabled/);
  assert.match(releaseGates, /disabled_skip_covered_by/);
  assert.match(releaseGates, /requireSourcePreflightSemantics/);
  assert.match(releaseGates, /source_preflight_upstream_profile_storage/);
  assert.match(releaseGates, /source_preflight_antigravity_cli_isolation_profile/);
  assert.match(releaseGates, /source_preflight_antigravity_cli_profile_prepare/);
  assert.match(releaseGates, /source_preflight_antigravity_cli_profile_prepare_rejects_default_child/);
  assert.match(releaseGates, /source_preflight_antigravity_cli_windows_user_login_dry_run/);
  assert.match(releaseGates, /source_preflight_windows_user_login_readiness_not_checked/);
  assert.match(releaseGates, /source_preflight_windows_user_login_target_is_current_user/);
  assert.match(releaseGates, /source_preflight_windows_user_login_credential_boundary/);
  assert.match(releaseGates, /source_preflight_windows_user_login_expected_credential_isolation/);
  assert.match(releaseGates, /source_preflight_profile_prepare_used_real_traffic/);
  assert.match(releaseGates, /source_preflight_profile_prepare_contract_missing/);
  assert.match(releaseGates, /source_preflight_profile_prepare_login_verified/);
  assert.match(releaseGates, /source_preflight_profile_prepare_separate_account_verified/);
  assert.match(releaseGates, /source_preflight_profile_prepare_account_lane_role/);
  assert.match(releaseGates, /source_preflight_profile_prepare_mcp_lane_managed_by_anticodex/);
  assert.match(releaseGates, /source_preflight_profile_prepare_mcp_lane_owner_mismatch/);
  assert.match(releaseGates, /source_preflight_profile_prepare_coverage_kind/);
  assert.match(releaseGates, /source_preflight_profile_prepare_isolation_boundary_missing/);
  assert.match(releaseGates, /source_preflight_profile_prepare_isolation_caveat_missing/);
  assert.match(releaseGates, /source_preflight_local_connector_verifier/);
  assert.match(releaseGates, /source_preflight_public_documentation/);
  assert.match(releaseGates, /source_preflight_public_documentation_client_sync_contract/);
  assert.match(releaseGates, /hasSuccessfulDocAssertion/);
  assert.match(releaseGates, /prepare-anticodex-antigravity-cli-profile\.ps1/);
  assert.match(releaseGates, /latest-antigravity-cli-real-smoke\.json/);
  assert.match(releaseGates, /optional_antigravity_cli_real_smoke_login_not_verified/);
  assert.match(releaseGates, /optional_antigravity_cli_real_smoke_strict_isolation_missing/);
  assert.match(releaseGates, /optional_antigravity_cli_real_smoke_separate_account_verified_missing/);
  assert.match(releaseGates, /optional_antigravity_cli_real_smoke_separate_account_identity_evidence_missing/);
  assert.match(releaseGates, /optional_antigravity_cli_real_smoke_identity_comparison_missing/);
  assert.match(releaseGates, /optional_antigravity_cli_real_smoke_anticodex_account_id_missing/);
  assert.match(releaseGates, /optional_antigravity_cli_real_smoke_mcp_account_id_missing/);
  assert.match(releaseGates, /optional_antigravity_cli_real_smoke_identity_accounts_match/);
  assert.match(releaseGates, /optional_antigravity_cli_real_smoke_anticodex_identity_source/);
  assert.match(releaseGates, /optional_antigravity_cli_real_smoke_mcp_identity_source/);
  assert.match(releaseGates, /optional_antigravity_cli_real_smoke_identity_comparison_method/);
  assert.match(releaseGates, /optional_antigravity_cli_real_smoke_identity_captured_at/);
  assert.match(releaseGates, /optional_antigravity_cli_real_smoke_identity_approval_id/);
  assert.match(releaseGates, /optional_antigravity_cli_real_smoke_identity_approval_source/);
  assert.match(releaseGates, /explicit-user-approved-account-identity-parameter/);
  assert.match(releaseGates, /explicit-user-approval/);
  assert.match(releaseGates, /optional_antigravity_cli_real_smoke_identity_evidence_without_verification/);
  assert.match(releaseGates, /optional_antigravity_cli_real_smoke_isolation_boundary_missing/);
  assert.match(releaseGates, /optional_antigravity_cli_real_smoke_isolation_caveat_missing/);
  assert.match(releaseGates, /optional_antigravity_cli_real_smoke_credential_boundary_insufficient/);
  assert.match(releaseGates, /same-Windows-user profile\/AppData isolation is insufficient/);
  assert.match(releaseGates, /separate Windows user or official independent credential store/);
  assert.match(releaseGates, /test-anticodex-antigravity-cli-real-smoke\.ps1 -AllowRealTraffic -WindowsUser <target-windows-user> -ProfileRoot <isolated-antigravity-cli-profile> -StrictWindowsAppDataIsolation -AccountIsolationBoundary <separate-windows-user\|official-independent-credential-store> -AllowSeparateAccountProof -AntiCodexAccountId <anticodex-account-id-or-fingerprint> -McpAccountId <mcp-account-id-or-fingerprint> -SeparateAccountProofApprovalId <explicit-user-approval-id>/);
  assert.match(releaseGates, /model-text lane/);
  assert.match(releaseGates, /MCP/);
  assert.match(releaseGates, /externally managed/);
  assert.match(releaseGates, /not managed here/);
  assert.match(releaseGates, /account-identity evidence/);
  assert.match(releaseGates, /requireModelRoutingSemantics/);
  assert.match(releaseGates, /model_routing_skip_requests_not_true/);
  assert.match(releaseGates, /model_routing_result_not_skipped/);
  assert.match(releaseGates, /requireModelThinkingSemantics/);
  assert.match(releaseGates, /model_thinking_actual_count/);
  assert.match(releaseGates, /model_thinking_supports_thinking/);
  assert.match(releaseGates, /model_thinking_budget/);
  assert.match(releaseGates, /requireToolBridgeSemantics/);
  assert.match(releaseGates, /tool_bridge_not_model_only_or_explicit_native/);
  assert.match(releaseGates, /codex-owned-tools-model-only/);
  assert.match(releaseGates, /codex_owned_model_only_tool_bridge/);
  assert.match(releaseGates, /requireUiIdleSemantics/);
  assert.match(releaseGates, /ui_idle_reconnect_text/);
  assert.match(releaseGates, /ui_idle_login_text/);
  assert.match(releaseGates, /ui_idle_model_text_missing/);
  assert.match(releaseGates, /requireSyncReadinessSemantics/);
  assert.match(releaseGates, /sync_readiness_no_traffic_attestation/);
  assert.match(releaseGates, /sync_readiness_full_mode_required/);
  assert.match(releaseGates, /sync_readiness_active_host/);
  assert.match(releaseGates, /sync_readiness_shortcuts/);
  assert.match(releaseGates, /sync_readiness_manager_bridge/);
  assert.match(releaseGates, /sync_readiness_rollback_host/);
  assert.match(releaseGates, /sync_readiness_source_active_hash_mismatch/);
  assert.match(releaseGates, /requireMcpSkillSemantics/);
  assert.match(releaseGates, /mcp_skills_missing_shared_mcp/);
  assert.match(releaseGates, /mcp_skills_changed_shared_mcp/);
  assert.match(releaseGates, /mcp_skills_missing_shared_skills/);
  assert.match(releaseGates, /mcp_skills_extra_local_skills/);
  assert.match(releaseGates, /mcp_skills_conflicting_duplicate_skills/);
  assert.match(releaseGates, /Number\(skills\.expectedSharedCount \|\| 0\) < Number\(skills\.count \|\| 0\)/);
  assert.match(releaseGates, /mcp_skills_real_call_not_passed/);
  assert.match(releaseGates, /mcp_skills_missing_worker_real_list/);
  assert.match(releaseGates, /mcp_skills_no_agents_skills/);
  assert.match(releaseGates, /requireUsedRealTraffic/);
  assert.match(releaseGates, /expected_usedRealTraffic_true/);
  assert.match(releaseGates, /requireToolLoopSemantics: "standard"/);
  assert.match(releaseGates, /requireToolLoopSemantics: "native"/);
  assert.match(releaseGates, /requireToolLoopSemantics: "native-multi"/);
  assert.match(releaseGates, /requireToolLoopSemantics: "mcp"/);
  assert.match(releaseGates, /requireToolLoopSemantics: "custom"/);
  assert.match(releaseGates, /tool_loop_marker_missing/);
  assert.match(releaseGates, /native_tool_loop_pseudo_call_id/);
  assert.match(releaseGates, /native_multi_tool_loop_native_call_ids_missing/);
  assert.match(releaseGates, /mcp_tool_loop_real_mcp_missing/);
  assert.match(releaseGates, /custom_tool_loop_input_not_preserved/);
  assert.match(releaseGates, /requireWebToolsSemantics/);
  assert.match(releaseGates, /requireCompactionResumeSemantics/);
  assert.match(releaseGates, /requireCancellationSemantics/);
  assert.match(releaseGates, /web_tools_evidence_missing/);
  assert.match(releaseGates, /compaction_resume_summary_seed_missing/);
  assert.match(releaseGates, /cancellation_cancelled_event_missing/);
  assert.match(releaseGates, /requireRealMiniToolSemantics/);
  assert.match(releaseGates, /requireRealWorkSemantics/);
  assert.match(releaseGates, /real_mini_tool_marker_mismatch/);
  assert.match(releaseGates, /real_work_mcp_missing/);
  assert.match(releaseGates, /expected_no_real_traffic/);
  assert.match(releaseGates, /expected_no_real_traffic_coverage_kind/);
  assert.match(releaseGates, /optional_requested_real_traffic_uncovered_but_ok/);
  assert.match(releaseGates, /optional_skipped_requested_real_traffic_not_false/);
  assert.match(releaseGates, /optional_skipped_used_real_traffic/);
  assert.match(releaseGates, /optional_skipped_metadata_missing/);
  assert.match(releaseGates, /optional_real_traffic_not_requested/);
  assert.match(releaseGates, /optionalAntigravitySkipped/);
  assert.match(releaseGates, /optional_real_provider_report_name/);
  assert.match(releaseGates, /optional_real_provider_history_missing/);
  assert.match(releaseGates, /optional_real_provider_route_transport/);
  assert.match(releaseGates, /optional_real_provider_route_protocol/);
  assert.match(releaseGates, /optional_real_provider_route_model/);
  assert.match(releaseGates, /optional_real_provider_route_status/);
  assert.match(releaseGates, /optional_real_provider_return_not_used/);
  assert.match(releaseGates, /optional_real_provider_return_history_missing/);
  assert.match(releaseGates, /optional_real_provider_return_previous_response_id_mismatch/);
  assert.match(releaseGates, /optional_real_provider_return_marker_count/);
  assert.match(releaseGates, /optional_real_provider_return_missing_markers/);
  assert.match(releaseGates, /optional_real_provider_return_upstream_not_antigravity/);
  assert.match(releaseGates, /optional_real_provider_return_route_transport/);
  assert.match(releaseGates, /optional_real_provider_return_requested_model/);
  assert.match(releaseGates, /optional_real_provider_return_resolved_model/);
  assert.match(releaseGates, /optional_real_provider_required/);
  assert.match(releaseGates, /optional_antigravity_return_report_name/);
  assert.match(releaseGates, /optional_antigravity_return_missing_markers/);
  assert.match(releaseGates, /optional_antigravity_return_route_transport/);
  assert.match(releaseGates, /optional_antigravity_return_required/);
  assert.match(releaseGates, /requireThirdPartyProviderSemantics/);
  assert.match(releaseGates, /third_party_provider_turn_count/);
  assert.match(releaseGates, /third_party_provider_openai_tool_pair_lost/);
  assert.match(releaseGates, /third_party_provider_anthropic_tool_pair_lost/);
  assert.match(releaseGates, /third_party_provider_turn9_marker_coverage/);
  assert.match(releaseGates, /third_party_provider_switch_previous_response_id_missing/);
  assert.match(releaseGates, /third_party_provider_protocol_previous_response_id_missing/);
  assert.match(releaseGates, /third_party_provider_reverse_protocol_previous_response_id_missing/);
  assert.match(releaseGates, /manager_action_missing_real_click/);
  assert.match(releaseGates, /local_connector_report_name/);
  assert.match(releaseGates, /local_connector_used_real_traffic/);
  assert.match(releaseGates, /local_connector_behavior_not_covered/);
  assert.match(releaseGates, /local_connector_coverage_kind/);
  assert.match(releaseGates, /local_connector_chatgpt_urls_not_scrubbed/);
  assert.match(releaseGates, /local_connector_link_endpoints_not_metadata_only/);
  assert.match(releaseGates, /appToolGetPostParity\.contentMatches !== true/);
  assert.match(releaseGates, /local_connector_upstream_requests_during_local_endpoints/);
  assert.match(releaseGates, /local_connector_linked_connector_not_accessible/);
  assert.match(releaseGates, /local_connector_hidden_connector_accessible/);
  assert.match(releaseGates, /local_connector_get_post_tool_mismatch/);
  assert.match(releaseGates, /local_connector_unexpected_exposed_tool/);
  assert.match(releaseGates, /local_connector_exposed_tool_names_mismatch/);
  assert.match(releaseGates, /plugin_capabilities_app_tool_get_post_mismatch/);
  assert.match(releaseGates, /plugin_capabilities_unauthorized_app_tools/);
  assert.match(releaseGates, /plugin_capabilities_local_connector_parity_missing_shared/);
  assert.match(releaseGates, /plugin_capabilities_local_connector_parity_extra_local/);
  assert.match(releaseGates, /plugin_capabilities_local_connector_parity_changed_shared/);
  assert.match(releaseGates, /plugin_capabilities_local_app_tool_parity_changed_shared/);
  assert.match(releaseGates, /plugin_capabilities_local_app_tool_parity_extra_local/);
  assert.match(releaseGates, /plugin_capabilities_local_app_tool_parity_missing_shared/);
  assert.match(releaseGates, /releaseReady/);
  assert.match(releaseGates, /shortReady/);
  assert.match(releaseGates, /releaseBlockedOnlyByRequiredRealTraffic/);
  assert.match(releaseGates, /requiredRealTrafficBlockedGates/);
  assert.match(releaseGates, /--strict-optional-real-traffic/);
  assert.match(releaseGates, /strictOptionalRealTraffic/);
  assert.match(releaseGates, /optionalRealTrafficReady/);
  assert.match(releaseGates, /optionalRealTrafficFailures/);
  assert.match(releaseGates, /sourceFingerprint/);
  assert.match(releaseGates, /refresh_features_source_snapshot_missing/);
  assert.match(releaseGates, /refresh_features_source_snapshot_mismatch/);
  assert.match(releaseGates, /mcp_skills_source_snapshot_missing/);
  assert.match(releaseGates, /mcp_skills_source_snapshot_mismatch/);
  assert.match(releaseGates, /mcp_skills_changed_shared_skills/);
  assert.match(releaseGates, /plugin_capabilities_source_snapshot_missing/);
  assert.match(releaseGates, /plugin_capabilities_source_snapshot_mismatch/);
  assert.match(releaseGates, /missingRequired/);
  assert.match(releaseGates, /missingShort/);
  assert.match(releaseGates, /missingOptional/);
  assert.match(releaseGates, /damagedReports/);
  assert.match(releaseGates, /selectedKind/);
  assert.match(releaseGates, /releaseGateSelectedReports/);
  assert.match(releaseGates, /selectedMtime/);
  assert.match(releaseGates, /reportFailureSamples/);
  assert.match(releaseGates, /local_gateway_offline/);
  assert.match(releaseGates, /local_gateway_required/);
  assert.match(releaseGates, /runtime_sync_refresh_required/);
  assert.match(releaseGates, /real_traffic_evidence_stale/);
  assert.match(releaseGates, /optional_stability_soak_required/);
  assert.match(releaseGates, /optional_cold_relaunch_required/);
  assert.match(releaseGates, /requires explicit user approval/);
  assert.match(releaseGates, /orderedActions/);
  assert.match(releaseGates, /releaseGateFailures/);
  assert.match(releaseGates, /releaseGateGroups/);
  assert.match(releaseGates, /failureReasonsAvailableCount/);
  assert.match(releaseGates, /failureReasonsHiddenCount/);
  assert.match(releaseGates, /semanticFailuresAvailableCount/);
  assert.match(releaseGates, /semanticFailuresHiddenCount/);
  assert.match(releaseGates, /nextActions/);
  assert.match(releaseGates, /nextActionsAvailableCount/);
  assert.match(releaseGates, /nextActionsHiddenCount/);
  assert.match(releaseGates, /nextActionsTruncated/);
  assert.match(releaseGates, /nextActions truncation evidence was not summarized/);
  assert.match(releaseGates, /short failed gates missing next actions/);
  assert.match(releaseGates, /nextActions did not preserve gate guidance/);
  assert.match(releaseGates, /real-traffic nextActions did not preserve gate guidance/);
  assert.match(releaseGates, /gate ordered actions did not preserve reason and guidance/);
  assert.match(releaseGates, /approvalPlan/);
  assert.match(releaseGates, /const approvalPlan = summarizeApprovalPlan\(nextActionSummary\.allActions\)/);
  assert.match(releaseGates, /summarizeApprovalPlan/);
  assert.match(releaseGates, /approval plan did not summarize gateway, real-traffic, and high-impact actions/);
  assert.match(releaseGates, /reportFailureSampleCodes/);
  assert.match(releaseGates, /gateway_endpoint_unreachable/);
  assert.match(releaseGates, /local_gateway_offline/);
  assert.match(releaseGates, /blockedUntilExplicitUserApproval/);
  assert.match(releaseGates, /reportOnly/);
  assert.match(releaseGates, /reportOnlyCount/);
  assert.match(releaseGates, /reportOnly: phaseActions\.some/);
  assert.match(releaseGates, /report-only/);
  assert.match(releaseGates, /semantic failure report-only action was not attached before real traffic/);
  assert.match(releaseGates, /approval plan did not count report-only actions/);
  assert.match(releaseGates, /offlineSnapshotEvidence/);
  assert.match(releaseGates, /plugin offline snapshot evidence was not attached from refresh-features/);
  assert.match(releaseGates, /pluginCapabilities still needs the local gateway for runtime endpoint evidence/);
  assert.match(releaseGates, /real-traffic ordered action was not marked gateway and real-traffic/);
  assert.match(releaseGates, /account-proxy ordered action was not marked gateway and real-traffic/);
  assert.match(releaseGates, /optional stability-soak action was not marked gateway and real-traffic/);
  assert.match(releaseGates, /realTrafficRefreshOrder/);
  assert.match(releaseGates, /shortEvidenceRefreshOrder/);
  assert.match(releaseGates, /noTrafficEvidenceRefreshOrder/);
  assert.match(releaseGates, /managerEvidenceRefreshOrder/);
  assert.match(releaseGates, /test-anticodex-source-preflight\.ps1 -SkipFullRegression/);
  assert.match(releaseGates, /test-anticodex-local-connectors\.mjs --report-root \$env:APPDATA/);
  assert.match(releaseGates, /test-anticodex-model-routing\.ps1 -SkipRequests -TimeoutSec 20/);
  assert.match(releaseGates, /sync-anticodex-runtime\.ps1 -NoRestart -TimeoutSec 10/);
  assert.match(releaseGates, /required failed gates missing ordered actions/);
  assert.match(releaseGates, /nextActions contained an action without a command/);
  assert.match(releaseGates, /test-anticodex-manager-real-buttons\.ps1 -TimeoutSec 120/);
  assert.match(releaseGates, /manager real-button ordered action was not attached/);
  assert.match(releaseGates, /test-anticodex-account-proxy-readiness\.ps1 -TimeoutSec 120/);
  assert.match(releaseGates, /requireAccountProxySemantics/);
  assert.match(releaseGates, /account_proxy_real_request_not_ok/);
  assert.match(releaseGates, /semantically invalid account-proxy report satisfied the gate/);
  assert.match(releaseGates, /requirePostVerificationSemantics/);
  assert.match(releaseGates, /post_verification_overall_not_release_ready/);
  assert.match(releaseGates, /semantically invalid post-verification report satisfied the gate/);
  assert.match(releaseGates, /requireCodexResponsesSemantics/);
  assert.match(releaseGates, /codex_responses_marker_missing/);
  assert.match(releaseGates, /semantically invalid codex-responses report satisfied the gate/);
  assert.match(releaseGates, /requireUiChatSmokeSemantics/);
  assert.match(releaseGates, /latest-ui-chat-smoke\.json/);
  assert.match(releaseGates, /latest-ui-multi-turn-project-smoke\.json/);
  assert.match(releaseGates, /requireMultiTurnProject/);
  assert.match(releaseGates, /ui_multi_turn_project_smoke_unique_export_missing/);
  assert.match(releaseGates, /ui_chat_smoke_marker_missing/);
  assert.match(releaseGates, /ui_chat_smoke_session_lock_not_clear/);
  assert.match(releaseGates, /semantically invalid ui-chat-smoke report satisfied the gate/);
  assert.match(releaseGates, /actionPhaseOrder/);
  assert.match(releaseGates, /top-level nextActions did not keep post-verification last/);
  assert.match(releaseGates, /realMiniTool ordered action was not marked gateway\/high-impact/);
  assert.match(releaseGates, /realWork ordered action was not marked gateway\/high-impact/);
  assert.match(releaseGates, /optionalEvidenceRefreshOrder/);
  assert.match(releaseGates, /test-anticodex-stability-soak\.ps1 -DurationSec 180/);
  assert.match(releaseGates, /test-anticodex-cold-relaunch\.ps1 -ConfirmRelaunch/);
  assert.match(releaseGates, /optional cold-relaunch action was not marked gateway\/high-impact/);
  assert.match(releaseGates, /optional stability-soak action was not marked gateway and real-traffic/);
  assert.match(releaseGates, /plugin_capabilities_source_snapshot_reused/);
  assert.match(releaseGates, /real-traffic stale guidance was not attached/);
  assert.match(releaseGates, /latest report failure samples were not preserved/);
  assert.match(releaseGates, /requiredSatisfied/);
  assert.match(releaseGates, /optionalSatisfied/);
  assert.match(releaseGates, /--strict/);
  assert.match(releaseGates, /missing_hash_sidecar/);
  assert.match(releaseGates, /hash_mismatch/);
  assert.match(releaseGates, /requireInstalledOverallSemantics/);
  assert.match(releaseGates, /installed_overall_coverage_kind/);
  assert.match(releaseGates, /installed_overall_model_text_transport_not_cli/);
  assert.match(releaseGates, /installed_overall_model_discovery_source_missing/);
  assert.match(releaseGates, /installed_overall_model_discovery_source_not_allowed/);
  assert.match(releaseGates, /antigravity-coworker/);
  assert.match(releaseGates, /antigravity-cli-catalog/);
  assert.match(releaseGates, /installed_overall_antigravity_coworker_default_not_false/);
  assert.match(releaseGates, /installed_overall_real_traffic_skip_missing/);
  assert.match(releaseGates, /allowedFullSkipped = new Set\(\[[\s\S]*"managerButtonMcpSkills"[\s\S]*"managerButtonPluginCapabilities"[\s\S]*"uiIdleStability"/);
  assert.match(releaseGates, /nonBlockingHostSyncCheck/);
  assert.match(releaseGates, /host_sync_required_not_runtime_unusable/);
  assert.match(releaseGates, /entry\.value\.overallBlocking === false/);
  assert.match(releaseGates, /entry\.value\.releaseBlocking === true/);
  assert.match(releaseGates, /--self-test/);
  assert.match(releaseGates, /semantically invalid installed-overall report satisfied the gate/);
  assert.match(releaseGates, /semantically invalid no-traffic report satisfied the gate/);
  assert.match(releaseGates, /semantically invalid model-routing report satisfied the gate/);
  assert.match(releaseGates, /semantically invalid model-thinking report satisfied the gate/);
  assert.match(releaseGates, /semantically invalid ui-idle report satisfied the gate/);
  assert.match(releaseGates, /semantically invalid sync-readiness report satisfied the gate/);
  assert.match(releaseGates, /sync_readiness_client_sync_version_mismatch/);
  assert.match(releaseGates, /sync_readiness_client_patch_scope_extra/);
  assert.match(releaseGates, /sync_readiness_history_source_mismatch/);
  assert.match(releaseGates, /stale sync-readiness history source satisfied the gate/);
  assert.match(releaseGates, /function syncReadinessSourceEvidence/);
  assert.match(releaseGates, /sync-readiness extra Anti-Codex patch scope satisfied the gate/);
  assert.match(releaseGates, /id:\s*"syncHost"[\s\S]*?sync-anticodex-launcher\.ps1[\s\S]*?highImpact:\s*true/);
  assert.match(releaseGates, /sync-readiness host-sync action was not marked high-impact/);
  assert.match(releaseGates, /sync-readiness host-sync samples were not normalized/);
  assert.match(releaseGates, /host_sync_required/);
  assert.match(releaseGates, /semantically invalid cold-relaunch report satisfied the gate/);
  assert.match(releaseGates, /tool_bridge_not_model_only_or_explicit_native/);
  assert.match(releaseGates, /semantically invalid source-preflight report satisfied the gate/);
  assert.match(releaseGates, /semantically invalid MCP\/Skill report satisfied the gate/);
  assert.match(releaseGates, /real-traffic-only nextActions should not prepend gateway start as a separate blocker/);
  assert.match(releaseGates, /real-traffic-only approval plan should point at the first required real-traffic gate/);
  assert.match(releaseGates, /semantically invalid optional real-traffic report satisfied the gate/);
  assert.match(releaseGates, /semantically invalid real provider optional report satisfied the gate/);
  assert.match(releaseGates, /semantically invalid Antigravity return optional report satisfied the gate/);
  assert.match(releaseGates, /semantically invalid third-party provider report satisfied the gate/);
  assert.match(releaseGates, /semantically invalid missing-history report satisfied the gate/);
  assert.match(releaseGates, /semantically invalid local-connector report satisfied the gate/);
  assert.match(releaseGates, /semantically invalid plugin-capability report satisfied the gate/);
  assert.match(releaseGates, /latest-log-db-guard\.json/);
  assert.match(releaseGates, /requireLogDbGuardSemantics/);
  assert.match(releaseGates, /log_db_guard_no_traffic/);
  assert.match(releaseGates, /log_db_guard_used_real_traffic/);
  assert.match(releaseGates, /log_db_guard_coverage_kind/);
  assert.match(releaseGates, /log_db_guard_trigger_missing/);
  assert.match(releaseGates, /log_db_guard_wal_bytes_invalid/);
  assert.match(releaseGates, /requireRefreshFeatureSemantics/);
  assert.match(releaseGates, /refresh_features_connector_parity/);
  assert.match(releaseGates, /refresh_features_app_tool_parity/);
  assert.match(server, /latestManagerReportItem\("Release Gate 汇总", "latest-release-gates\.json"\)/);
  assert.match(server, /effectiveOk/);
  assert.match(server, /report\?\.releaseReady === true/);
  assert.match(server, /const passed=\(item\.effectiveOk!==null&&item\.effectiveOk!==undefined\)\?item\.effectiveOk:item\.ok/);
  assert.match(managerInject, /const passed = item\.effectiveOk !== null && item\.effectiveOk !== undefined \? item\.effectiveOk : item\.ok/);
  assert.match(managerBridge, /const passed = item\.effectiveOk !== null && item\.effectiveOk !== undefined \? item\.effectiveOk : item\.ok/);
  assert.match(managerInject, /installedOverall model: transport=\$\{evidence\.modelTextTransport \|\| "unknown"\} \/ discovery=\$\{evidence\.modelDiscoverySource \|\| "unknown"\} \/ coworkerDefault=/);
  assert.match(managerBridge, /installedOverall model: transport=\$\{evidence\.modelTextTransport \|\| "unknown"\} \/ discovery=\$\{evidence\.modelDiscoverySource \|\| "unknown"\} \/ coworkerDefault=/);
  assert.match(collector, /latest-release-gates\.json/);
  assert.match(server, /releaseGateGroups/);
  assert.match(server, /selectedHistory/);
  assert.match(server, /failureReasons/);
  assert.match(server, /nextActions/);
  assert.match(server, /Release groups:/);
  assert.match(releaseGates, /installedRuntimeSync/);
  assert.match(releaseGates, /installedRuntimeEvidenceFromGate/);
  assert.match(releaseGates, /installedRuntimeEvidence/);
  assert.match(releaseGates, /runtimeSyncFiles/);
  assert.match(releaseGates, /scripts\/anticodex-manager-inject\.js/);
  assert.match(releaseGates, /scripts\/anticodex-manager-open-inject\.js/);
  assert.match(releaseGates, /scripts\/anticodex-manager-bridge\.mjs/);
  assert.match(releaseGates, /scripts\/collect-anticodex-diagnostics\.ps1/);
  assert.match(releaseGates, /scripts\/summarize-anticodex-report\.mjs/);
  assert.match(releaseGates, /scripts\/start-anticodex-antigravity-cli-login\.ps1/);
  assert.match(releaseGates, /scripts\/start-anticodex-antigravity-cli-login-windows-user\.ps1/);
  assert.match(releaseGates, /scripts\/test-anticodex-antigravity-cli-dual-account-lanes\.ps1/);
  assert.match(releaseGates, /scripts\/test-anticodex-local-connectors\.mjs/);
  assert.match(releaseGates, /scripts\/test-anticodex-mcp-skills\.ps1/);
  assert.match(releaseGates, /scripts\/probe-anticodex-worker-mcp-servers\.mjs/);
  assert.match(releaseGates, /scripts\/test-anticodex-missing-history\.mjs/);
  assert.match(releaseGates, /scripts\/test-anticodex-model-routing\.ps1/);
  assert.match(releaseGates, /scripts\/test-anticodex-model-thinking\.ps1/);
  assert.match(releaseGates, /scripts\/test-anticodex-plugin-capabilities\.ps1/);
  assert.match(releaseGates, /scripts\/test-anticodex-release-gates\.mjs/);
  assert.match(releaseGates, /scripts\/test-anticodex-source-preflight\.ps1/);
  assert.match(releaseGates, /scripts\/test-anticodex-sync-readiness\.ps1/);
  assert.match(releaseGates, /scripts\/test-anticodex-third-party-provider\.mjs/);
  assert.match(releaseGates, /scripts\/test-anticodex-tool-bridge-mode\.ps1/);
  assert.match(releaseGates, /translator\/antigravity-upstream\.mjs/);
  assert.match(releaseGates, /translator\/response-history\.mjs/);
  assert.match(releaseGates, /translator\/local-projection\/index\.mjs/);
  assert.match(releaseGates, /translator\/upstream-provider\.mjs/);
  assert.match(syncRuntime, /scripts\\anticodex-manager-inject\.js/);
  assert.match(syncRuntime, /scripts\\anticodex-manager-open-inject\.js/);
  assert.match(syncRuntime, /scripts\\start-anticodex-antigravity-cli-login\.ps1/);
  assert.match(syncRuntime, /scripts\\start-anticodex-antigravity-cli-login-windows-user\.ps1/);
  assert.match(syncRuntime, /scripts\\test-anticodex-antigravity-cli-dual-account-lanes\.ps1/);
  assert.match(syncRuntime, /scripts\\anticodex-manager-bridge\.mjs/);
  assert.match(syncRuntime, /scripts\\collect-anticodex-diagnostics\.ps1/);
  assert.match(syncRuntime, /scripts\\summarize-anticodex-report\.mjs/);
  assert.match(syncRuntime, /scripts\\test-anticodex-local-connectors\.mjs/);
  assert.match(syncRuntime, /scripts\\test-anticodex-mcp-skills\.ps1/);
  assert.match(syncRuntime, /scripts\\probe-anticodex-worker-mcp-servers\.mjs/);
  assert.match(syncRuntime, /scripts\\test-anticodex-missing-history\.mjs/);
  assert.match(mcpProbe, /StdioClientTransport/);
  assert.match(mcpProbe, /client\.listTools\(\)/);
  assert.match(mcpProbe, /reportName: "worker-mcp-server-probe"/);
  assert.match(mcpProbe, /latest-worker-mcp-server-probe\.json/);
  assert.match(mcpProbe, /mimo-claude-coworker/);
  assert.match(mcpProbe, /mimocode-worker/);
  assert.match(mcpProbe, /antigravity-code-worker/);
  assert.doesNotMatch(mcpProbe, /start_implementation|implement_in_workspace|callTool/);
  assert.match(syncRuntime, /scripts\\test-anticodex-model-routing\.ps1/);
  assert.match(syncRuntime, /scripts\\test-anticodex-model-thinking\.ps1/);
  assert.match(syncRuntime, /scripts\\test-anticodex-plugin-capabilities\.ps1/);
  assert.match(syncRuntime, /scripts\\test-anticodex-release-gates\.mjs/);
  assert.match(syncRuntime, /scripts\\test-anticodex-source-preflight\.ps1/);
  assert.match(syncRuntime, /scripts\\test-anticodex-sync-readiness\.ps1/);
  assert.match(syncRuntime, /scripts\\test-anticodex-third-party-provider\.mjs/);
  assert.match(syncRuntime, /scripts\\test-anticodex-tool-bridge-mode\.ps1/);
  assert.match(syncRuntime, /translator\\antigravity-upstream\.mjs/);
  assert.match(syncRuntime, /translator\\response-history\.mjs/);
  assert.match(syncRuntime, /translator\\local-projection\\index\.mjs/);
  assert.match(syncRuntime, /translator\\upstream-provider\.mjs/);
  assert.match(releaseGates, /installed_runtime_hash_mismatch/);
  assert.match(releaseGates, /installed_runtime_fingerprint_mismatch/);
  assert.match(releaseGates, /mcp_skills_app_tool_registry_content_mismatch/);
  assert.match(releaseGates, /mcp_skills_app_tool_registry_fingerprint_mismatch/);
  assert.match(releaseGates, /targetRuntime/);
  assert.doesNotMatch(collector, mjsVerifierPowerShellWrapper);
  assert.doesNotMatch(sourcePreflight, mjsVerifierPowerShellWrapper);
  assert.doesNotMatch(syncRuntime, mjsVerifierPowerShellWrapper);
  assert.match(collector, /Get-Command node\.exe/);
  assert.match(collector, /summarize-anticodex-report\.mjs/);
  assert.ok(releaseGateReportFiles.length >= 30, "release-gate report inventory should stay non-trivial");
  for (const reportFile of releaseGateReportFiles) {
    assert.match(collector, reportFilePattern(reportFile), `${reportFile} must be included in diagnostic bundles`);
    assert.match(server, reportFilePattern(reportFile), `${reportFile} must be visible in Manager latest reports`);
    assert.match(installedOverall, reportFilePattern(reportFile), `${reportFile} must be covered by installed report integrity checks`);
  }
  assert.doesNotMatch(releaseGates, /fetch\(|node:(?:http|https|net|child_process)|require\(["'](?:http|https|net|node:http|node:https|node:net|child_process|node:child_process)["']\)|Invoke-RestMethod|Invoke-WebRequest|Start-Process|Stop-Process|auth\/login|OPENAI_API_KEY|ANTHROPIC_API_KEY/);
});

test("passive release gate compact status emits a short parseable summary", () => {
  const tempRoot = mkdtempSync(resolve(os.tmpdir(), "anticodex-release-gates-status-"));
  try {
    const result = spawnSync(process.execPath, [
      resolve(root, "scripts", "test-anticodex-release-gates.mjs"),
      "--report-root", tempRoot,
      "--compact-status",
    ], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.reportName, "release-gates-status");
    assert.equal(typeof summary.shortReady, "boolean");
    assert.equal(typeof summary.releaseReady, "boolean");
    assert.ok(Array.isArray(summary.missingRequired));
    assert.ok(Array.isArray(summary.missingShort));
    assert.ok(Array.isArray(summary.damagedReports));
    assert.ok(Array.isArray(summary.requiredRealTrafficBlockedGates));
    assert.equal(Object.hasOwn(summary, "gates"), false);
    assert.equal(Object.hasOwn(summary, "releaseGateFailureReasons"), false);
    assert.equal(Object.hasOwn(summary, "nextActions"), false);
    assert.equal(existsSync(resolve(tempRoot, "latest-release-gates.json")), true);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("passive release gate self-test executes successfully", () => {
  const result = spawnSync(process.execPath, [
    resolve(root, "scripts", "test-anticodex-release-gates.mjs"),
    "--self-test",
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.ok, true);
  assert.equal(summary.selfTest, true);
  assert.ok(Array.isArray(summary.semanticFailures.thirdPartyProvider));
  assert.ok(summary.semanticFailures.thirdPartyProvider.includes("third_party_provider_turn9_marker_coverage"));
  assert.ok(summary.semanticFailures.thirdPartyProvider.includes("third_party_provider_turn9_ordered_history"));
  assert.ok(summary.semanticFailures.thirdPartyProvider.includes("third_party_provider_turn6_marker_coverage"));
  assert.ok(summary.semanticFailures.thirdPartyProvider.includes("third_party_provider_turn6_ordered_history"));
  assert.ok(summary.semanticFailures.sourcePreflight.includes("source_preflight_local_connector_verifier"));
  assert.ok(summary.semanticFailures.sourcePreflight.includes("source_preflight_antigravity_cli_isolation_profile"));
  assert.ok(summary.semanticFailures.sourcePreflight.includes("source_preflight_antigravity_cli_profile_prepare"));
  assert.ok(summary.semanticFailures.sourcePreflight.includes("source_preflight_antigravity_cli_profile_prepare_rejects_default_child"));
  assert.ok(summary.semanticFailures.sourcePreflightProfilePrepareContract.includes("source_preflight_profile_prepare_used_real_traffic"));
  assert.ok(summary.semanticFailures.sourcePreflightProfilePrepareContractMissing.includes("source_preflight_profile_prepare_contract_missing"));
  assert.ok(summary.semanticFailures.sourcePreflightProfilePrepareContract.includes("source_preflight_profile_prepare_login_verified"));
  assert.ok(summary.semanticFailures.sourcePreflightProfilePrepareContract.includes("source_preflight_profile_prepare_separate_account_verified"));
  assert.ok(summary.semanticFailures.sourcePreflightProfilePrepareContract.includes("source_preflight_profile_prepare_account_lane_role"));
  assert.ok(summary.semanticFailures.sourcePreflightProfilePrepareContract.includes("source_preflight_profile_prepare_mcp_lane_managed_by_anticodex"));
  assert.ok(summary.semanticFailures.sourcePreflightProfilePrepareContract.includes("source_preflight_profile_prepare_mcp_lane_owner_mismatch"));
  assert.ok(summary.semanticFailures.sourcePreflightProfilePrepareContract.includes("source_preflight_profile_prepare_coverage_kind"));
  assert.ok(summary.semanticFailures.sourcePreflightProfilePrepareContract.includes("source_preflight_profile_prepare_isolation_boundary_missing"));
  assert.ok(summary.semanticFailures.sourcePreflightProfilePrepareContract.includes("source_preflight_profile_prepare_isolation_caveat_missing"));
  assert.ok(summary.semanticFailures.optionalRealProvider.includes("optional_real_provider_report_name"));
  assert.ok(summary.semanticFailures.optionalAntigravityReturn.includes("optional_antigravity_return_report_name"));
  assert.ok(summary.semanticFailures.mcpSkills.includes("mcp_skills_changed_shared_mcp"));
  assert.ok(summary.semanticFailures.mcpSkills.includes("mcp_skills_conflicting_duplicate_skills"));
  assert.ok(summary.semanticFailures.mcpSkills.includes("mcp_skills_app_tool_registry_content_mismatch"));
  assert.ok(summary.semanticFailures.mcpSkills.includes("mcp_skills_app_tool_registry_fingerprint_mismatch"));
  assert.ok(summary.semanticFailures.mcpSkills.includes("mcp_skills_app_tool_registry_file_count_mismatch"));
  assert.ok(summary.semanticFailures.refreshFeatures.includes("refresh_features_connector_parity"));
  assert.ok(summary.semanticFailures.localConnectors.includes("local_connector_used_real_traffic"));
  assert.ok(summary.semanticFailures.localConnectors.includes("local_connector_get_post_tool_mismatch"));
  assert.ok(summary.semanticFailures.pluginCapabilities.includes("plugin_capabilities_local_connector_parity_changed_shared"));
  assert.ok(summary.semanticFailures.logDbGuard.includes("log_db_guard_trigger_missing"));
  assert.ok(summary.semanticFailures.sourceSnapshotMismatch.refreshFeatures.includes("refresh_features_source_snapshot_mismatch"));
  assert.ok(summary.semanticFailures.sourceSnapshotMismatch.mcpSkills.includes("mcp_skills_source_snapshot_mismatch"));
  assert.ok(summary.semanticFailures.sourceSnapshotMismatch.pluginCapabilities.includes("plugin_capabilities_source_snapshot_mismatch"));
  assert.ok(summary.semanticFailures.installedRuntimeSync.includes("installed_runtime_hash_mismatch"));
  assert.ok(summary.semanticFailures.installedRuntimeSync.includes("installed_runtime_fingerprint_mismatch"));
  assert.ok(summary.semanticFailures.installedOverallNoTraffic.includes("installed_overall_manager_verifier_lock_busy"));
});

test("release-required latest reports stay visible in diagnostics, Manager, and report integrity checks", () => {
  const releaseGates = readFileSync(resolve(root, "scripts", "test-anticodex-release-gates.mjs"), "utf8");
  const collector = readFileSync(resolve(root, "scripts", "collect-anticodex-diagnostics.ps1"), "utf8");
  const server = readFileSync(resolve(root, "translator", "adaptive-server.mjs"), "utf8");
  const installedOverall = readFileSync(resolve(root, "scripts", "test-anticodex-installed-overall.ps1"), "utf8");
  const thisFile = readFileSync(new URL(import.meta.url), "utf8");
  const requiredReports = Array.from(new Set(Array.from(releaseGates.matchAll(/\{[^}]*file:\s*"([^"]+\.json)"[^}]*requiredForRelease:\s*true[^}]*\}/g), (match) => match[1]))).sort();
  const hasReportReference = (source, report) => source.includes(report) || source.includes(report.replace(".json", "\\.json"));

  assert.ok(requiredReports.length > 20, "release gate required report inventory should be parsed");
  assert.ok(requiredReports.includes("latest-refresh-features.json"), "refresh-features evidence must block release when stale or missing");
  for (const report of requiredReports) {
    assert.ok(collector.includes(report), `${report} missing from diagnostic bundle latestReports`);
    assert.ok(server.includes(report), `${report} missing from Manager latest reports`);
    assert.ok(installedOverall.includes(report), `${report} missing from installed overall report integrity list`);
    assert.ok(hasReportReference(thisFile, report), `${report} missing from launcher contract coverage`);
  }
});

test("Anti-Codex guards against ambient background suggestions without real traffic", () => {
  const verifier = readFileSync(resolve(root, "scripts", "test-anticodex-ambient-suggestions.ps1"), "utf8");
  const overall = readFileSync(resolve(root, "scripts", "test-anticodex-installed-overall.ps1"), "utf8");
  const collector = readFileSync(resolve(root, "scripts", "collect-anticodex-diagnostics.ps1"), "utf8");
  const releaseGates = readFileSync(resolve(root, "scripts", "test-anticodex-release-gates.mjs"), "utf8");
  const summarizer = readFileSync(resolve(root, "scripts", "summarize-anticodex-report.mjs"), "utf8");
  const diagnostics = readFileSync(resolve(root, "scripts", "test-anticodex-diagnostics.ps1"), "utf8");
  const server = readFileSync(resolve(root, "translator", "adaptive-server.mjs"), "utf8");

  assert.match(verifier, /reportName\s*=\s*"ambient-suggestions"/);
  assert.match(verifier, /latest-\$Name\.json/);
  assert.match(verifier, /noTraffic\s*=\s*\$true/);
  assert.match(verifier, /usedRealTraffic\s*=\s*\$false/);
  assert.match(verifier, /behaviorCovered\s*=\s*\$true/);
  assert.match(verifier, /coverageKind\s*=\s*"installed-no-traffic"/);
  assert.match(verifier, /OnDeviceHeadSuggestModel/);
  assert.match(verifier, /test-anticodex-ambient-suggestions\\.ps1/);
  assert.match(verifier, /bodyTextHitCount/);
  assert.match(verifier, /tableHits/);
  assert.match(verifier, /columnHits/);
  assert.match(verifier, /targetHits/);
  assert.match(verifier, /shared-plugin-host\/skills\/gstack\/scripts\/proactive-suggestions/);
  assert.match(verifier, /\^ambient-suggestions\(\/\.\*\)\?\$/);
  assert.match(verifier, /discards_proactive/);
  assert.match(verifier, /reloads_proactive/);

  assert.match(overall, /ambientSuggestions/);
  assert.match(overall, /test-anticodex-ambient-suggestions\.ps1/);
  assert.match(overall, /latest-ambient-suggestions\.json/);
  assert.match(collector, /latest-ambient-suggestions\.json/);
  assert.match(collector, /ambientSuggestionsEvidence = \$json\.ambientSuggestionsEvidence/);
  assert.match(server, /latest-ambient-suggestions\.json/);
  assert.match(
    server,
    /const ambientSuggestionsBeforeReadiness = deterministicAmbientSuggestionsCompletion\(parsed, null\);[\s\S]*?if \(antigravityMode\) \{[\s\S]*?const readinessFailure = antigravityReadinessFailure/,
  );
  assert.match(summarizer, /ambientSuggestionsEvidence/);

  assert.match(releaseGates, /id:\s*"ambientSuggestions"[\s\S]*?file:\s*"latest-ambient-suggestions\.json"[\s\S]*?requiredForRelease:\s*true/);
  assert.match(releaseGates, /requireAmbientSuggestionSemantics:\s*true/);
  assert.match(releaseGates, /ambient_suggestions_report_name/);
  assert.match(releaseGates, /ambient_suggestions_used_real_traffic/);
  assert.match(releaseGates, /ambient_suggestions_failures/);
  assert.match(releaseGates, /ambient_suggestions_sqlite_sources/);
});

test("Anti-Codex requires a real desktop UI chat smoke before release", () => {
  const verifier = readFileSync(resolve(root, "scripts", "test-anticodex-ui-chat-smoke.mjs"), "utf8");
  const overall = readFileSync(resolve(root, "scripts", "test-anticodex-installed-overall.ps1"), "utf8");
  const collector = readFileSync(resolve(root, "scripts", "collect-anticodex-diagnostics.ps1"), "utf8");
  const releaseGates = readFileSync(resolve(root, "scripts", "test-anticodex-release-gates.mjs"), "utf8");
  const summarizer = readFileSync(resolve(root, "scripts", "summarize-anticodex-report.mjs"), "utf8");
  const signer = readFileSync(resolve(root, "scripts", "sign-anticodex-reports.mjs"), "utf8");
  const server = readFileSync(resolve(root, "translator", "adaptive-server.mjs"), "utf8");

  assert.match(verifier, /const reportName = [\s\S]*"ui-chat-smoke"/);
  assert.match(verifier, /"ui-local-project-smoke"/);
  assert.match(verifier, /"ui-coding-project-smoke"/);
  assert.match(verifier, /"ui-repo-file-edit-smoke"/);
  assert.match(verifier, /"ui-repo-multi-file-edit-smoke"/);
  assert.match(verifier, /"ui-report-site-smoke"/);
  assert.match(verifier, /请在 \$\{artifactDir\} 里创建一个很小的 Node\.js CLI 项目/);
  assert.match(verifier, /这是两轮任务的第 1 轮/);
  assert.match(verifier, /继续同一个项目：\$\{artifactDir\}/);
  assert.match(verifier, /const promptLanguage = \/\[\\u3400-\\u9fff\]\/u\.test\(promptText\) \? "zh" : "en"/);
  assert.match(verifier, /followupPromptLanguage = \/\[\\u3400-\\u9fff\]\/u\.test\(followupPromptText\) \? "zh" : "en"/);
  assert.match(verifier, /promptLanguage/);
  assert.match(verifier, /followupPromptText/);
  assert.match(verifier, /followupPromptLanguage/);
  assert.match(verifier, /let cdpPort = Number\(args\.get\("--cdp-port"\) \|\| process\.env\.DEEPCODEX_CDP_PORT \|\| 0\)/);
  assert.match(verifier, /async function resolveCdpTargets/);
  assert.match(verifier, /function discoverAntiCodexCdpPorts\(\)/);
  assert.match(verifier, /ProcessName -eq 'Anti-Codex\.exe'/);
  assert.match(verifier, /\[\.\.\.discoverAntiCodexCdpPorts\(\), 58318, 58317\]/);
  assert.match(verifier, /ui-chat-smoke\.lock/);
  assert.match(verifier, /async function acquireUiSmokeLock/);
  assert.match(verifier, /process\.once\("exit", \(\) => releaseUiLock\?\.\(\)\)/);
  assert.match(verifier, /another desktop UI smoke is still running/);
  assert.match(verifier, /function recoverStaleComposerExpression/);
  assert.match(verifier, /删除排队的消息/);
  assert.match(verifier, /function sendButtonProbeExpression/);
  assert.match(verifier, /data-codex-composer/);
  assert.match(verifier, /size-token-button-composer/);
  assert.match(verifier, /aria-disabled/);
  assert.match(verifier, /data-disabled/);
  assert.match(verifier, /projectMatched/);
  assert.match(verifier, /"exact-marker"/);
  assert.match(verifier, /"free-chat"/);
  assert.match(verifier, /"web-search"/);
  assert.match(verifier, /function visibleMainPaneText\(\)/);
  assert.match(verifier, /rect\.left < 300/);
  assert.match(verifier, /diagnosticsUrl = `\$\{baseUrl\}\/anticodex\/diagnostics\?fast=1`/);
  assert.match(verifier, /modelRoutesUrl = `\$\{baseUrl\}\/anticodex\/model-routes`/);
  assert.match(verifier, /async function collectModelRouteEvidence\(before\)/);
  assert.match(verifier, /modelRouteEvidence = await collectModelRouteEvidence\(modelRoutesBefore\)/);
  assert.match(verifier, /modelRouteEvidence/);
  assert.match(verifier, /args\.get\("--model"\)/);
  assert.match(verifier, /args\.get\("--model-label"\)/);
  assert.match(verifier, /function collectRequiredModelFailures/);
  assert.match(verifier, /desktop UI did not select required model/);
  assert.match(verifier, /usedRealTraffic:\s*false/);
  assert.match(verifier, /modelSelectionEvidence/);
  assert.match(server, /diagnosticsPayload\(\{ fast: url\.searchParams\.get\("fast"\) === "1" \}\)/);
  assert.match(server, /reason: "fast_diagnostics"/);
  assert.match(verifier, /const projectChatLabel = String\(args\.get\("--project-label"\) \|\| "Anti-Codex"\)/);
  assert.match(verifier, /newChatClickExpression\(requiresProjectChat \? projectChatLabel : ""\)/);
  assert.match(verifier, /project task did not open a \$\{projectChatLabel\} project chat before submit/);
  assert.match(verifier, /const promptFile = args\.get\("--prompt-file"\) \? resolve\(String\(args\.get\("--prompt-file"\)\)\) : ""/);
  assert.match(verifier, /readFileSync\(promptFile, "utf8"\)/);
  assert.match(verifier, /const hasCustomPrompt = Boolean\(promptFromFile \|\| args\.get\("--prompt"\)\)/);
  assert.match(verifier, /project task composer was still projectless before clicking send/);
  assert.match(verifier, /composer did not contain exactly the submitted prompt before clicking send/);
  assert.match(verifier, /send button was not found in the composer controls/);
  assert.match(verifier, /Network\.enable/);
  assert.match(verifier, /Input\.dispatchMouseEvent/);
  assert.match(verifier, /clickMethod:\s*"cdp-mouse"/);
  assert.match(verifier, /summarizeNetworkEvents/);
  assert.match(verifier, /networkEvents/);
  assert.match(verifier, /firstPersonProgressCount/);
  assert.match(verifier, /firstPersonProgressSamples/);
  assert.match(verifier, /firstPersonProgressCount === 0/);
  assert.match(verifier, /first-person visible progress updates/);
  assert.doesNotMatch(verifier, /visibleProgressPattern = \/[^;\n]*我/);
  assert.doesNotMatch(server, /function contentHasVisibleToolProgress[\s\S]{0,500}\|我/);
  assert.match(verifier, /send click did not submit the composer prompt/);
  assert.match(verifier, /submitSucceeded/);
  assert.match(verifier, /async function waitForComposerPromptReady/);
  assert.match(verifier, /async function waitForComposerSubmitted/);
  assert.match(verifier, /async function pressComposerEnter/);
  assert.match(verifier, /enterFallback/);
  assert.match(verifier, /if \(clicked && submitSucceeded\)/);
  assert.match(verifier, /submitEvidence/);
  assert.match(verifier, /staleRecovery/);
  assert.match(verifier, /Search the web for recent Codex updates/);
  assert.match(verifier, /Use PowerShell file commands to create exactly these files/);
  assert.match(verifier, /Do not create README\.md/);
  assert.match(verifier, /Create exactly these files and no others: report\.md, index\.html, done\.txt/);
  assert.match(verifier, /Use PowerShell only to run Node\.js file-write commands/);
  assert.match(verifier, /Do not create README\.md; README\.md is explicitly wrong for this task/);
  assert.match(verifier, /Your first file write action must create report\.md, not README\.md/);
  assert.match(verifier, /do not use Set-Content, Out-File, or PowerShell redirection for JSON or JavaScript files/);
  assert.match(verifier, /must define stripUtf8Bom\(text\)/);
  assert.match(verifier, /must call stripUtf8Bom before JSON\.parse/);
  assert.match(verifier, /Do not inspect Antigravity brain, transcript, history, or log folders/);
  assert.match(verifier, /function stripUtf8Bom/);
  assert.match(verifier, /function parseJsonFile/);
  assert.match(verifier, /JSON\.parse\(stripUtf8Bom/);
  assert.match(verifier, /taskMode === "local-project"/);
  assert.match(verifier, /function verifyLocalProjectArtifact/);
  assert.match(verifier, /function verifyCodingProjectArtifact/);
  assert.match(verifier, /function verifyRepoFileEditFixture/);
  assert.match(verifier, /function verifyRepoMultiFileEditFixture/);
  assert.match(verifier, /function verifyReportSiteArtifact/);
  assert.match(verifier, /node:test did not pass/);
  assert.match(verifier, /execFileSync\(process\.execPath, \["--test", testPath\]/);
  assert.match(verifier, /CLI output did not contain red=2 and blue=1/);
  assert.match(verifier, /function buildReportSiteRepairPrompt/);
  assert.match(verifier, /function buildComplexProjectRepairPrompt/);
  assert.match(verifier, /report-site repair-step/);
  assert.match(verifier, /complex-project repair-step/);
  assert.match(verifier, /sources\.json must be written as UTF-8 without BOM/);
  assert.match(verifier, /stripUtf8Bom before JSON\.parse/);
  assert.match(verifier, /report-site report\.md was not created/);
  assert.match(verifier, /report-site index\.html has fewer than three source URLs/);
  assert.match(verifier, /report-site report\.md missing Chinese content/);
  assert.match(verifier, /local-project done\.txt did not exactly match the marker/);
  assert.match(verifier, /artifactEvidence/);
  assert.match(verifier, /artifactDir/);
  assert.match(verifier, /requestedRealTraffic:\s*true/);
  assert.match(verifier, /usedRealTraffic:\s*true/);
  assert.match(verifier, /coverageKind:\s*"desktop-ui-real-traffic"/);
  assert.match(verifier, /markerCount/);
  assert.match(verifier, /answerMarkerCount/);
  assert.match(verifier, /inLoopIdleDiagnostics/);
  assert.match(verifier, /inLoopIdleObserved/);
  assert.match(verifier, /composerCleared/);
  assert.match(verifier, /clickMethod: "dom-click"/);
  assert.match(verifier, /mouseFallback/);
  assert.match(verifier, /enterFallback/);
  assert.match(verifier, /sessionLockClear/);
  assert.match(verifier, /timing/);
  assert.match(verifier, /submitCompletedAt/);
  assert.match(verifier, /firstReplySeenAt/);
  assert.match(verifier, /idleCompletedAt/);
  assert.match(verifier, /submitMs/);
  assert.match(verifier, /firstReplyMs/);
  assert.match(verifier, /idleWaitMs/);
  assert.match(verifier, /function diagnosticsAreIdle/);
  assert.match(verifier, /async function waitForIdleDiagnostics/);
  assert.match(verifier, /const idleTimeoutMs = taskMode === "local-project" \|\| taskMode === "coding-project" \|\| taskMode === "multi-turn-project" \|\| taskMode === "complex-project" \|\| taskMode === "autonomous-reasoning" \|\| taskMode === "report-site" \|\| taskMode === "agentic-step-flow" \|\| taskMode === "repo-file-edit" \|\| taskMode === "repo-multi-file-edit" \? 60_000 : 20_000/);
  assert.match(verifier, /desktop task did not become idle after the assistant reply/);
  assert.match(verifier, /antigravitySessionLock/);
  assert.match(verifier, /activeAntigravityRequests/);
  assert.match(verifier, /antigravityQueue/);
  assert.match(verifier, /diagnostics endpoint did not respond after desktop task/);
  assert.match(verifier, /desktop task left the Antigravity session lock active/);
  assert.match(verifier, /latest-\$\{reportName\}\.json/);
  assert.match(verifier, /function responseHistoryHasToolOutputMarker/);
  assert.match(verifier, /function waitForDesktopToolTurnSettled/);
  assert.match(verifier, /hasStopButton/);
  assert.match(verifier, /thinkingTextSeen/);
  assert.doesNotMatch(verifier, /buttons\.some\(\(button\) => \/正在思考\|Thinking\/i\.test\(button\.innerText \|\| ''\)\)/);
  assert.match(verifier, /desktop tool result did not settle into response history before the follow-up/);
  assert.match(verifier, /follow-up was not submitted because turn1 tool output was not settled/);
  assert.match(verifier, /taskMode === "complex-project"/);
  assert.match(verifier, /const complexProjectRequiresModelLed = taskMode === "complex-project";/);
  assert.match(verifier, /taskMode === "repo-file-edit"/);
  assert.match(verifier, /Do not start with Get-ChildItem/);
  assert.match(verifier, /Your first tool action must modify/);
  assert.match(verifier, /taskMode === "repo-multi-file-edit"/);
  assert.match(verifier, /ui-complex-project-smoke/);
  assert.match(verifier, /repo-file-edit node:test did not pass after the desktop task/);
  assert.match(verifier, /repo-multi-file-edit CLI output did not contain ok=2 needs-review=1 blocked=1/);
  assert.match(verifier, /repo-multi-file-edit source was not changed from the failing fixture/);
  assert.match(verifier, /repo-multi-file-edit modified the acceptance test/);
  assert.match(verifier, /repo-multi-file-edit modified the input data/);
  assert.match(verifier, /function repoMultiArtifactIdleSettle\(turn, phase, evidence\)/);
  assert.match(verifier, /artifact_idle_without_history_wait/);
  assert.match(verifier, /historyToolOutputRequired:\s*false/);
  assert.match(verifier, /function artifactProgressEvidenceForWait\(evidence, options = \{\}\)/);
  assert.match(verifier, /options\.readmeOnly === true[\s\S]*evidence\?\.files\?\.readme === true/);
  assert.match(verifier, /sourceChangedFromFixture === true/);
  assert.match(verifier, /firstTurnSettle/);
  assert.match(verifier, /finalTurnSettle/);
  const repoMultiPostSubmitMatch = verifier.match(/if \(taskMode === "repo-multi-file-edit"\) \{\s*artifactEvidence = verifyRepoMultiFileEditFixture\(marker\);[\s\S]*?(?=\n\s*if \(taskMode === "local-project"\) \{)/);
  assert.ok(repoMultiPostSubmitMatch);
  const repoMultiPostSubmitBlock = repoMultiPostSubmitMatch[0];
  assert.doesNotMatch(repoMultiPostSubmitBlock, /waitForDesktopToolTurnSettled\(ws, marker, Math\.min\(timeoutMs, 120_000\)\)/);
  assert.match(verifier, /Your first and only tool action for this step must write \$\{repoMultiFileReadme\}/);
  assert.match(verifier, /function jsSingleQuotedLiteral\(value\)/);
  assert.match(verifier, /function buildRepoMultiReadmeWriteCommand\(\)/);
  assert.match(verifier, /PowerShell-safe Node command before any other command/);
  assert.match(verifier, /require\('node:fs'\)\.writeFileSync/);
  assert.match(verifier, /\\\\u4f7f\\\\u7528\\\\u8bf4\\\\u660e/);
  assert.match(verifier, /artifactCompletionObserved/);
  assert.match(verifier, /Do not run git status/);
  assert.match(verifier, /Do not use apply_patch for this fixture task/);
  assert.match(verifier, /htmlOffline/);
  assert.match(verifier, /HTML used external assets or link\/preconnect tags/);
  assert.match(verifier, /no http\/https URLs, no <link tags, and no preconnect/);
  assert.match(verifier, /fonts\\.googleapis\|fonts\\.gstatic/);
  assert.match(verifier, /onlyReadmeMissing/);
  assert.match(verifier, /Create only \$\{repoMultiFileReadme\}, containing the Chinese title/);
  assert.match(verifier, /Your first and only tool action now must execute exactly this PowerShell-safe Node command/);
  assert.match(verifier, /idleBreakAfterMs/);
  assert.match(verifier, /artifactEvidence\?\.testPassed === true/);
  assert.doesNotMatch(verifier, /taskMode === "repo-file-edit" \? 30_000 : 12_000/);
  assert.match(verifier, /codex-update-analyzer\.mjs/);
  assert.match(verifier, /sources\.json/);
  assert.match(verifier, /summarizeSources/);

  assert.match(overall, /uiChatSmoke/);
  assert.match(overall, /test-anticodex-ui-chat-smoke\.mjs/);
  assert.match(overall, /latest-ui-chat-smoke\.json/);
  assert.match(overall, /latest-ui-local-project-smoke\.json/);
  assert.match(overall, /latest-ui-coding-project-smoke\.json/);
  assert.match(overall, /latest-ui-multi-turn-project-smoke\.json/);
  assert.match(overall, /latest-ui-repo-file-edit-smoke\.json/);
  assert.match(overall, /latest-ui-repo-multi-file-edit-smoke\.json/);
  assert.match(overall, /latest-ui-complex-project-smoke\.json/);
  assert.match(overall, /latest-ui-report-site-smoke\.json/);
  assert.match(collector, /latest-ui-chat-smoke\.json/);
  assert.match(collector, /latest-ui-web-search-smoke\.json/);
  assert.match(collector, /latest-ui-local-project-smoke\.json/);
  assert.match(collector, /latest-ui-coding-project-smoke\.json/);
  assert.match(collector, /latest-ui-multi-turn-project-smoke\.json/);
  assert.match(collector, /latest-ui-repo-file-edit-smoke\.json/);
  assert.match(collector, /latest-ui-repo-multi-file-edit-smoke\.json/);
  assert.match(collector, /latest-ui-complex-project-smoke\.json/);
  assert.match(collector, /latest-ui-report-site-smoke\.json/);
  assert.match(collector, /uiChatSmokeEvidence = \$json\.uiChatSmokeEvidence/);
  assert.match(collector, /uiWebSearchSmokeEvidence = \$json\.uiWebSearchSmokeEvidence/);
  assert.match(collector, /uiLocalProjectEvidence = \$json\.uiLocalProjectEvidence/);
  assert.match(collector, /uiCodingProjectEvidence = \$json\.uiCodingProjectEvidence/);
  assert.match(collector, /uiMultiTurnProjectEvidence = \$json\.uiMultiTurnProjectEvidence/);
  assert.match(collector, /uiRepoFileEditEvidence = \$json\.uiRepoFileEditEvidence/);
  assert.match(collector, /uiRepoMultiFileEditEvidence = \$json\.uiRepoMultiFileEditEvidence/);
  assert.match(collector, /uiComplexProjectEvidence = \$json\.uiComplexProjectEvidence/);
  assert.match(collector, /uiReportSiteEvidence = \$json\.uiReportSiteEvidence/);
  assert.match(signer, /latest-ui-local-project-smoke\.json/);
  assert.match(signer, /latest-ui-coding-project-smoke\.json/);
  assert.match(signer, /latest-ui-multi-turn-project-smoke\.json/);
  assert.match(signer, /latest-ui-repo-file-edit-smoke\.json/);
  assert.match(signer, /latest-ui-repo-multi-file-edit-smoke\.json/);
  assert.match(signer, /latest-ui-complex-project-smoke\.json/);
  assert.match(signer, /latest-ui-report-site-smoke\.json/);
  assert.match(server, /latest-ui-chat-smoke\.json/);
  assert.match(server, /latest-ui-web-search-smoke\.json/);
  assert.match(server, /latest-ui-local-project-smoke\.json/);
  assert.match(server, /latest-ui-coding-project-smoke\.json/);
  assert.match(server, /latest-ui-multi-turn-project-smoke\.json/);
  assert.match(server, /latest-ui-repo-file-edit-smoke\.json/);
  assert.match(server, /latest-ui-repo-multi-file-edit-smoke\.json/);
  assert.match(server, /Local project edit requirement/);
  assert.match(server, /do not start with a directory listing/);
  assert.match(server, /Repeated directory listings are not progress/);
  assert.match(server, /files have already been inspected/);
  assert.match(server, /latest-ui-complex-project-smoke\.json/);
  assert.match(server, /latest-ui-report-site-smoke\.json/);
  assert.match(server, /uiChatSmokeEvidence/);
  assert.match(server, /uiWebSearchSmokeEvidence/);
  assert.match(server, /uiLocalProjectEvidence/);
  assert.match(server, /uiCodingProjectEvidence/);
  assert.match(server, /uiMultiTurnProjectEvidence/);
  assert.match(server, /uiRepoFileEditEvidence/);
  assert.match(server, /uiRepoMultiFileEditEvidence/);
  assert.match(server, /sourceChangedFromFixture/);
  assert.match(server, /inputsLocked=/);
  assert.match(server, /uiComplexProjectEvidence/);
  assert.match(server, /uiReportSiteEvidence/);
  assert.match(server, /uiChat:/);
  assert.match(server, /uiWebSearch:/);
  assert.match(server, /uiLocalProject:/);
  assert.match(server, /uiCoding:/);
  assert.match(server, /uiMultiTurn:/);
  assert.match(server, /uiRepoMulti:/);
  assert.match(server, /uiComplex:/);
  assert.match(server, /uiReportSite:/);
  assert.match(summarizer, /uiChatSmokeEvidence/);
  assert.match(summarizer, /uiWebSearchSmokeEvidence/);
  assert.match(summarizer, /uiLocalProjectEvidence/);
  assert.match(summarizer, /uiCodingProjectEvidence/);
  assert.match(summarizer, /uiMultiTurnProjectEvidence/);
  assert.match(summarizer, /uiRepoFileEditEvidence/);
  assert.match(summarizer, /uiRepoMultiFileEditEvidence/);
  assert.match(summarizer, /asRepoMultiSettleEvidence/);
  assert.match(summarizer, /diagnosticsPresent/);
  assert.match(summarizer, /testUnchanged/);
  assert.match(summarizer, /dataUnchanged/);
  assert.match(summarizer, /firstTurnSettle/);
  assert.match(summarizer, /finalTurnSettle/);
  assert.match(summarizer, /uiComplexProjectEvidence/);
  assert.match(summarizer, /uiReportSiteEvidence/);
  assert.match(summarizer, /reportHasMarker/);
  assert.match(summarizer, /htmlHasMarker/);
  assert.match(summarizer, /reportHasChinese/);
  assert.match(summarizer, /htmlHasChinese/);
  assert.match(summarizer, /reportMentionsCodex/);
  assert.match(summarizer, /htmlMentionsCodex/);

  assert.match(releaseGates, /id:\s*"uiChatSmoke"[\s\S]*?file:\s*"latest-ui-chat-smoke\.json"[\s\S]*?requiredForRelease:\s*true/);
  assert.match(releaseGates, /requireUiChatSmokeSemantics:\s*true/);
  assert.match(releaseGates, /ui_chat_smoke_marker_missing/);
  assert.match(releaseGates, /ui_chat_smoke_session_lock_not_clear/);
  assert.match(releaseGates, /ui_repo_multi_file_edit_smoke_source_unchanged/);
  assert.match(releaseGates, /ui_repo_multi_file_edit_smoke_test_modified/);
  assert.match(releaseGates, /ui_repo_multi_file_edit_smoke_data_modified/);
  assert.match(releaseGates, /repoMultiSettleEvidenceOk/);
  assert.match(releaseGates, /typeof value\.diagnostics === "object"/);
  assert.match(releaseGates, /ui_repo_multi_file_edit_smoke_first_turn_settle_missing/);
  assert.match(releaseGates, /ui_repo_multi_file_edit_smoke_final_turn_settle_missing/);
  const requiredReports = Array.from(new Set(Array.from(releaseGates.matchAll(/\{[^}]*file:\s*"([^"]+\.json)"[^}]*requiredForRelease:\s*true[^}]*\}/g), (match) => match[1]))).sort();
  assert.ok(requiredReports.includes("latest-ui-web-search-smoke.json"), "desktop web-search evidence must be release-required");
  assert.ok(requiredReports.includes("latest-ui-local-project-smoke.json"), "desktop local-project evidence must be release-required");
  assert.ok(requiredReports.includes("latest-ui-coding-project-smoke.json"), "desktop coding-project evidence must be release-required");
  assert.ok(requiredReports.includes("latest-ui-multi-turn-project-smoke.json"), "desktop multi-turn project evidence must be release-required");
  assert.match(releaseGates, /ui-coding-project-smoke[\s\S]*?requirePromptLanguage:\s*"zh"/);
  assert.match(releaseGates, /ui-multi-turn-project-smoke[\s\S]*?requirePromptLanguage:\s*"zh"[\s\S]*?requireFollowupPromptLanguage:\s*"zh"/);
  assert.match(releaseGates, /_prompt_language/);
  assert.match(releaseGates, /_followup_prompt_language/);
  assert.ok(requiredReports.includes("latest-ui-repo-file-edit-smoke.json"), "desktop repo-file-edit evidence must be release-required");
  assert.ok(requiredReports.includes("latest-ui-repo-multi-file-edit-smoke.json"), "desktop repo multi-file edit evidence must be release-required");
  assert.ok(requiredReports.includes("latest-ui-complex-project-smoke.json"), "desktop complex-project evidence must be release-required");
  assert.ok(requiredReports.includes("latest-ui-report-site-smoke.json"), "desktop report-site evidence must be release-required");
});

test("Anti-Codex completes verified desktop artifact tool loops without reopening Antigravity", () => {
  const server = readFileSync(resolve(root, "translator", "adaptive-server.mjs"), "utf8");

  assert.match(server, /function requestIncludesToolOutput/);
  assert.match(server, /function deterministicArtifactCompletionResponse/);
  assert.match(server, /Anti-Codex artifact marker verification/);
  assert.match(server, /Files created and verified/);
  assert.match(server, /const artifactCompletion = deterministicArtifactCompletionResponse\(parsed, chatBody\)/);
  assert.match(server, /settleAntigravitySessionLease\(sessionLease, fmt\)/);
  assert.match(server, /artifactCompletion[\s\S]*?return parsed\.stream === false \? jsonResponse\(res, 200, fmt\) : pipeSSE\(res, fmt\)/);
});

test("Anti-Codex ships a guarded concrete desktop task suite runner", () => {
  const suite = readFileSync(resolve(root, "scripts", "test-anticodex-desktop-task-suite.mjs"), "utf8");
  const releaseGates = readFileSync(resolve(root, "scripts", "test-anticodex-release-gates.mjs"), "utf8");
  const runtimeSync = readFileSync(resolve(root, "scripts", "sync-anticodex-runtime.ps1"), "utf8");
  const collector = readFileSync(resolve(root, "scripts", "collect-anticodex-diagnostics.ps1"), "utf8");
  const diagnostics = readFileSync(resolve(root, "scripts", "test-anticodex-diagnostics.ps1"), "utf8");
  const signer = readFileSync(resolve(root, "scripts", "sign-anticodex-reports.mjs"), "utf8");
  const server = readFileSync(resolve(root, "translator", "adaptive-server.mjs"), "utf8");
  const installedOverall = readFileSync(resolve(root, "scripts", "test-anticodex-installed-overall.ps1"), "utf8");
  const summarizer = readFileSync(resolve(root, "scripts", "summarize-anticodex-report.mjs"), "utf8");
  const uiState = readFileSync(resolve(root, "scripts", "test-anticodex-ui-state.mjs"), "utf8");
  const managerBridge = readFileSync(resolve(root, "scripts", "anticodex-manager-bridge.mjs"), "utf8");
  const managerInject = readFileSync(resolve(root, "scripts", "anticodex-manager-inject.js"), "utf8");
  const agenticCapabilityMatrix = readFileSync(resolve(root, "scripts", "test-anticodex-agentic-capability-matrix.mjs"), "utf8");

  assert.match(suite, /allowRealTraffic = args\.has\("--allow-real-traffic"\)/);
  assert.match(suite, /--suite-profile/);
  assert.match(suite, /agenticTasks/);
  assert.match(suite, /extendedTasks/);
  assert.match(suite, /allTasks/);
  assert.match(suite, /dryRun = !allowRealTraffic/);
  assert.match(suite, /latest-desktop-task-suite\.json/);
  assert.match(suite, /createHash\("sha256"\)/);
  assert.match(suite, /test-anticodex-ui-chat-smoke\.mjs/);
  assert.match(suite, /"exact-marker"/);
  assert.match(suite, /"local-project"/);
  assert.match(suite, /"repo-file-edit"/);
  assert.match(suite, /"repo-multi-file-edit"/);
  assert.match(suite, /for \(const task of selectedTasks\)/);
  assert.match(suite, /spawnSync\(process\.execPath/);
  assert.match(suite, /requestedRealTraffic: allowRealTraffic/);
  assert.match(suite, /usedRealTraffic: allowRealTraffic && !dryRun/);
  assert.match(suite, /mode: dryRun \? "dry-run" : "real-traffic"/);
  assert.match(suite, /perTaskReports/);
  assert.match(suite, /latestRealTaskEvidence/);
  assert.match(suite, /realTaskEvidenceComplete/);
  assert.match(suite, /realTaskEvidenceFresh/);
  assert.match(suite, /--no-write-report/);
  assert.match(suite, /noWriteReport = args\.has\("--no-write-report"\)/);
  assert.match(suite, /if \(noWriteReport\)/);
  assert.match(suite, /noWriteReport: true/);
  assert.match(suite, /skipped: true/);
  assert.match(suite, /maxRealEvidenceAgeHours/);
  assert.match(suite, /realTaskEvidenceFailures/);
  assert.match(suite, /realTaskEvidenceRefreshPlan/);
  assert.match(suite, /requiresExplicitUserApproval/);
  assert.match(suite, /commandArgs: \[\.\.\.command\]/);
  assert.match(suite, /approvalSummary/);
  assert.match(suite, /taskScenarioCatalog/);
  assert.match(suite, /selectedTaskScenarios/);
  assert.match(suite, /workType/);
  assert.match(suite, /profileCoverage/);
  assert.match(suite, /mutatesRepoFixture/);
  assert.match(suite, /expectedEvidence/);
  assert.match(suite, /two-step-multi-file-repo-task/);
  assert.match(suite, /taskCount: refreshTaskModes\.length/);
  assert.match(suite, /realTrafficApprovalReason = "real_traffic_required"/);
  assert.match(suite, /staleTaskModes/);
  assert.match(suite, /hardFailureTaskModes/);
  assert.match(suite, /latest_real_report_stale/);
  assert.match(suite, /expectedReportName/);
  assert.match(suite, /expectedTaskMode/);
  assert.match(summarizer, /desktopTaskSuiteEvidence/);
  assert.match(summarizer, /agenticCapabilityMatrixEvidence/);
  assert.match(summarizer, /suiteProfile/);
  assert.match(summarizer, /realTaskEvidenceComplete/);
  assert.match(summarizer, /realTaskEvidenceFresh/);
  assert.match(summarizer, /realTaskEvidenceFreshnessFailureCount/);
  assert.match(summarizer, /realTaskEvidenceRefreshPlan/);
  assert.match(summarizer, /requiresExplicitUserApproval/);
  assert.match(summarizer, /realTaskEvidenceTasks/);
  assert.match(diagnostics, /desktopTaskSuiteEvidence/);
  assert.match(diagnostics, /desktop-task-suite summary missing desktopTaskSuiteEvidence/);
  assert.match(diagnostics, /desktop-task-suite summary real task evidence is not fresh/);
  assert.match(diagnostics, /Min\(30,\s*\[Math\]::Min\(\$TimeoutSec/);
  assert.match(diagnostics, /agentic-capability-matrix summary missing agenticCapabilityMatrixEvidence/);
  assert.match(diagnostics, /agentic-capability-matrix summary missing required capability/);
  assert.match(collector, /desktopTaskSuiteEvidence = \$json\.desktopTaskSuiteEvidence/);
  assert.match(collector, /agenticCapabilityMatrixEvidence = \$json\.agenticCapabilityMatrixEvidence/);
  assert.match(managerBridge, /desktopTaskSuite: profile=/);
  assert.match(managerBridge, /desktopTaskSuite refresh: needed=/);
  assert.match(managerInject, /desktopTaskSuite: profile=/);
  assert.match(managerInject, /desktopTaskSuite refresh: needed=/);
  assert.doesNotMatch(suite, /Promise\.all/);
  assert.match(releaseGates, /scripts\/test-anticodex-desktop-task-suite\.mjs/);
  assert.match(releaseGates, /scripts\/test-anticodex-agentic-capability-matrix\.mjs/);
  assert.match(releaseGates, /id: "desktopTaskSuite"/);
  assert.match(releaseGates, /latest-desktop-task-suite\.json/);
  assert.match(releaseGates, /requireDesktopTaskSuiteSemantics/);
  assert.match(releaseGates, /desktop_task_suite_real_task_evidence_not_fresh/);
  assert.match(releaseGates, /desktop_task_suite_\$\{task\.replaceAll\("-", "_"\)\}_scenario_missing/);
  assert.match(releaseGates, /desktop_task_suite_\$\{task\.replaceAll\("-", "_"\)\}_selected_scenario_missing/);
  assert.match(releaseGates, /id: "agenticCapabilityMatrix"/);
  assert.match(releaseGates, /latest-agentic-capability-matrix\.json/);
  assert.match(releaseGates, /requireAgenticCapabilityMatrixSemantics/);
  assert.match(releaseGates, /agentic_capability_matrix_missing_capabilities/);
  assert.match(runtimeSync, /scripts\\test-anticodex-desktop-task-suite\.mjs/);
  assert.match(runtimeSync, /scripts\\test-anticodex-agentic-capability-matrix\.mjs/);
  assert.match(collector, /latest-desktop-task-suite\.json/);
  assert.match(collector, /latest-agentic-capability-matrix\.json/);
  assert.match(signer, /latest-desktop-task-suite\.json/);
  assert.match(server, /latest-desktop-task-suite\.json/);
  assert.match(server, /latest-agentic-capability-matrix\.json/);
  assert.match(installedOverall, /latest-desktop-task-suite\.json/);
  assert.match(installedOverall, /latest-agentic-capability-matrix\.json/);
  assert.match(agenticCapabilityMatrix, /reportName: "agentic-capability-matrix"/);
  assert.match(agenticCapabilityMatrix, /requiredCapabilities/);
  assert.match(agenticCapabilityMatrix, /multi_turn_continuation/);
  assert.match(agenticCapabilityMatrix, /repo_multi_file_edit/);
  assert.match(agenticCapabilityMatrix, /requestedRealTraffic: false/);
  assert.match(agenticCapabilityMatrix, /usedRealTraffic: false/);
  assert.match(agenticCapabilityMatrix, /responseHistory/);
  assert.match(agenticCapabilityMatrix, /assistantHasFinalMarker/);
  assert.match(agenticCapabilityMatrix, /markerToolOutputSeen/);
  assert.match(agenticCapabilityMatrix, /visible_progress_too_shallow/);
  assert.match(agenticCapabilityMatrix, /visible_progress_not_distinct/);
  assert.match(agenticCapabilityMatrix, /artifact_guard_used/);
  assert.match(agenticCapabilityMatrix, /codex_like_process_proof_missing/);
  assert.match(agenticCapabilityMatrix, /task_tool_call_missing/);
  assert.match(agenticCapabilityMatrix, /task_tool_output_missing/);
  assert.match(uiState, /expectedDailyActionIds[\s\S]*"secondAccountLoginStatus"/);
});

test("desktop task suite dry-run audits stale latest real task evidence without using traffic", () => {
  const tempRoot = mkdtempSync(join(os.tmpdir(), "anticodex-desktop-suite-evidence-"));
  const reports = {
    "latest-ui-chat-smoke.json": ["ui-chat-smoke", "exact-marker"],
    "latest-ui-local-project-smoke.json": ["ui-local-project-smoke", "local-project"],
    "latest-ui-repo-file-edit-smoke.json": ["ui-repo-file-edit-smoke", "repo-file-edit"],
    "latest-ui-repo-multi-file-edit-smoke.json": ["ui-repo-multi-file-edit-smoke", "repo-multi-file-edit"],
  };
  try {
    for (const [file, [reportName, taskMode]] of Object.entries(reports)) {
      writeFileSync(join(tempRoot, file), `${JSON.stringify({
        ok: true,
        reportName,
        requestedRealTraffic: true,
        usedRealTraffic: true,
        taskMode,
        coverageKind: "desktop-ui-real-traffic",
        marker: `MARKER_${taskMode}`,
        elapsedMs: 1000,
        failures: [],
      }, null, 2)}\n`, "utf8");
    }
    const stalePath = join(tempRoot, "latest-ui-repo-multi-file-edit-smoke.json");
    const staleDate = new Date(Date.now() - 26 * 60 * 60 * 1000);
    utimesSync(stalePath, staleDate, staleDate);

    const result = spawnSync(process.execPath, [
      resolve(root, "scripts", "test-anticodex-desktop-task-suite.mjs"),
      "--report-root",
      tempRoot,
      "--max-real-evidence-age-hours",
      "24",
    ], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.requestedRealTraffic, false);
    assert.equal(report.usedRealTraffic, false);
    assert.equal(report.realTaskEvidenceComplete, true);
    assert.equal(report.realTaskEvidenceFresh, false);
    assert.ok(report.realTaskEvidenceFailures.some((failure) => failure === "repo-multi-file-edit_latest_real_report_stale"));
    assert.equal(report.latestRealTaskEvidence["repo-multi-file-edit"].fresh, false);
    assert.ok(report.latestRealTaskEvidence["repo-multi-file-edit"].ageMs > 24 * 60 * 60 * 1000);
    assert.deepEqual(report.realTaskEvidenceRefreshPlan.staleTaskModes, ["repo-multi-file-edit"]);
    assert.deepEqual(report.realTaskEvidenceRefreshPlan.hardFailureTaskModes, []);
    assert.equal(report.realTaskEvidenceRefreshPlan.requiresExplicitUserApproval, true);
    assert.equal(report.realTaskEvidenceRefreshPlan.approvalReason, "real_traffic_required");
    assert.equal(report.realTaskEvidenceRefreshPlan.commandPreview.includes("--allow-real-traffic"), true);
    assert.equal(report.realTaskEvidenceRefreshPlan.commandPreview.includes("--tasks repo-multi-file-edit"), true);
    assert.ok(Array.isArray(report.realTaskEvidenceRefreshPlan.commandArgs));
    assert.ok(report.realTaskEvidenceRefreshPlan.commandArgs.includes("--allow-real-traffic"));
    assert.equal(report.realTaskEvidenceRefreshPlan.approvalSummary.taskCount, 1);
    assert.deepEqual(report.realTaskEvidenceRefreshPlan.approvalSummary.refreshTaskModes, ["repo-multi-file-edit"]);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("desktop task suite supports an extended concrete task matrix without using traffic", () => {
  const tempRoot = mkdtempSync(join(os.tmpdir(), "anticodex-desktop-suite-profile-"));
  try {
    const result = spawnSync(process.execPath, [
      resolve(root, "scripts", "test-anticodex-desktop-task-suite.mjs"),
      "--report-root",
      tempRoot,
      "--suite-profile",
      "extended",
    ], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.requestedRealTraffic, false);
    assert.equal(report.usedRealTraffic, false);
    assert.equal(report.suiteProfile, "extended");
    assert.ok(report.selectedTasks.includes("exact-marker"));
    assert.ok(report.selectedTasks.includes("web-search"));
    assert.ok(report.selectedTasks.includes("coding-project"));
    assert.ok(report.selectedTasks.includes("multi-turn-project"));
    assert.ok(report.selectedTasks.includes("report-site"));
    assert.ok(report.selectedTasks.includes("complex-project"));
    assert.equal(report.perTaskReports["web-search"], "latest-ui-web-search-smoke.json");
    assert.equal(report.perTaskReports["coding-project"], "latest-ui-coding-project-smoke.json");
    assert.equal(report.perTaskReports["multi-turn-project"], "latest-ui-multi-turn-project-smoke.json");
    assert.equal(report.perTaskReports["report-site"], "latest-ui-report-site-smoke.json");
    assert.equal(report.perTaskReports["complex-project"], "latest-ui-complex-project-smoke.json");
    assert.equal(report.taskScenarioCatalog["web-search"].requiresWeb, true);
    assert.equal(report.taskScenarioCatalog["repo-multi-file-edit"].mutatesRepoFixture, true);
    assert.ok(report.taskScenarioCatalog["complex-project"].expectedEvidence.includes("sources-json"));
    assert.ok(report.selectedTaskScenarios["coding-project"].expectedEvidence.includes("node-test-passed"));
    assert.equal(report.realTaskEvidenceRefreshPlan.requiresExplicitUserApproval, true);
    assert.deepEqual(report.realTaskEvidenceRefreshPlan.hardFailureTaskModes.sort(), report.selectedTasks.slice().sort());
    assert.deepEqual(report.realTaskEvidenceRefreshPlan.staleTaskModes, []);
    assert.equal(report.realTaskEvidenceRefreshPlan.commandPreview.includes("--suite-profile extended"), true);
    assert.equal(report.realTaskEvidenceRefreshPlan.commandPreview.includes("--allow-real-traffic"), true);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("desktop task suite supports an agentic concrete task matrix without using traffic", () => {
  const tempRoot = mkdtempSync(join(os.tmpdir(), "anticodex-desktop-suite-agentic-"));
  try {
    const result = spawnSync(process.execPath, [
      resolve(root, "scripts", "test-anticodex-desktop-task-suite.mjs"),
      "--report-root",
      tempRoot,
      "--suite-profile",
      "agentic",
    ], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.requestedRealTraffic, false);
    assert.equal(report.usedRealTraffic, false);
    assert.equal(report.suiteProfile, "agentic");
    assert.deepEqual(report.selectedTasks, [
      "coding-project",
      "multi-turn-project",
      "report-site",
      "complex-project",
      "repo-multi-file-edit",
    ]);
    assert.equal(report.selectedTaskScenarios["report-site"].requiresWeb, true);
    assert.equal(report.selectedTaskScenarios["repo-multi-file-edit"].workType, "two-step-multi-file-repo-task");
    assert.equal(report.realTaskEvidenceRefreshPlan.requiresExplicitUserApproval, true);
    assert.equal(report.realTaskEvidenceRefreshPlan.commandPreview.includes("--suite-profile agentic"), true);
    assert.equal(report.realTaskEvidenceRefreshPlan.commandPreview.includes("--allow-real-traffic"), true);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("desktop task suite can preview all task refreshes without overwriting latest release evidence", () => {
  const tempRoot = mkdtempSync(join(os.tmpdir(), "anticodex-desktop-suite-preview-"));
  try {
    const agenticReports = {
      "latest-ui-chat-smoke.json": ["ui-chat-smoke", "exact-marker"],
      "latest-ui-local-project-smoke.json": ["ui-local-project-smoke", "local-project"],
      "latest-ui-coding-project-smoke.json": ["ui-coding-project-smoke", "coding-project"],
      "latest-ui-multi-turn-project-smoke.json": ["ui-multi-turn-project-smoke", "multi-turn-project"],
      "latest-ui-report-site-smoke.json": ["ui-report-site-smoke", "report-site"],
      "latest-ui-complex-project-smoke.json": ["ui-complex-project-smoke", "complex-project"],
      "latest-ui-repo-file-edit-smoke.json": ["ui-repo-file-edit-smoke", "repo-file-edit"],
      "latest-ui-repo-multi-file-edit-smoke.json": ["ui-repo-multi-file-edit-smoke", "repo-multi-file-edit"],
    };
    for (const [file, [reportName, taskMode]] of Object.entries(agenticReports)) {
      writeFileSync(join(tempRoot, file), `${JSON.stringify({
        ok: true,
        reportName,
        requestedRealTraffic: true,
        usedRealTraffic: true,
        taskMode,
        coverageKind: "desktop-ui-real-traffic",
        marker: `MARKER_${taskMode}`,
        elapsedMs: 1000,
        failures: [],
      }, null, 2)}\n`, "utf8");
    }

    const suitePath = resolve(root, "scripts", "test-anticodex-desktop-task-suite.mjs");
    const agenticResult = spawnSync(process.execPath, [
      suitePath,
      "--report-root",
      tempRoot,
      "--suite-profile",
      "agentic",
    ], { encoding: "utf8" });
    assert.equal(agenticResult.status, 0, agenticResult.stderr || agenticResult.stdout);
    const latestPath = join(tempRoot, "latest-desktop-task-suite.json");
    const latestBefore = readFileSync(latestPath, "utf8");
    const latestHashBefore = readFileSync(`${latestPath}.sha256`, "utf8");
    const previewResult = spawnSync(process.execPath, [
      suitePath,
      "--report-root",
      tempRoot,
      "--suite-profile",
      "all",
      "--no-write-report",
    ], { encoding: "utf8" });
    assert.equal(previewResult.status, 0, previewResult.stderr || previewResult.stdout);
    assert.equal(readFileSync(latestPath, "utf8"), latestBefore);
    assert.equal(readFileSync(`${latestPath}.sha256`, "utf8"), latestHashBefore);

    const preview = JSON.parse(previewResult.stdout);
    assert.equal(preview.report.skipped, true);
    assert.equal(preview.report.noWriteReport, true);
    assert.equal(preview.suiteProfile, "all");
    assert.ok(preview.selectedTasks.includes("free-chat"));
    assert.ok(preview.selectedTasks.includes("web-search"));
    assert.ok(preview.realTaskEvidenceRefreshPlan.refreshTaskModes.includes("free-chat"));
    assert.ok(preview.realTaskEvidenceRefreshPlan.refreshTaskModes.includes("web-search"));
    assert.equal(preview.realTaskEvidenceRefreshPlan.requiresExplicitUserApproval, true);
    assert.equal(preview.realTaskEvidenceRefreshPlan.commandPreview.includes("--allow-real-traffic"), true);
    assert.ok(Array.isArray(preview.realTaskEvidenceRefreshPlan.commandArgs));
    assert.equal(preview.realTaskEvidenceRefreshPlan.commandArgs.includes("--allow-real-traffic"), true);
    assert.deepEqual(preview.realTaskEvidenceRefreshPlan.commandArgs.slice(-3), ["--tasks", "free-chat,web-search", "--allow-real-traffic"]);
    assert.equal(preview.realTaskEvidenceRefreshPlan.approvalSummary.requiresExplicitUserApproval, true);
    assert.equal(preview.realTaskEvidenceRefreshPlan.approvalSummary.approvalReason, "real_traffic_required");
    assert.equal(preview.realTaskEvidenceRefreshPlan.approvalSummary.taskCount, 2);
    assert.deepEqual(preview.realTaskEvidenceRefreshPlan.approvalSummary.refreshTaskModes, ["free-chat", "web-search"]);
    assert.deepEqual(preview.realTaskEvidenceRefreshPlan.approvalSummary.hardFailureTaskModes, ["free-chat", "web-search"]);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("optional and special latest reports stay visible without becoming release-required", () => {
  const releaseGates = readFileSync(resolve(root, "scripts", "test-anticodex-release-gates.mjs"), "utf8");
  const collector = readFileSync(resolve(root, "scripts", "collect-anticodex-diagnostics.ps1"), "utf8");
  const server = readFileSync(resolve(root, "translator", "adaptive-server.mjs"), "utf8");
  const installedOverall = readFileSync(resolve(root, "scripts", "test-anticodex-installed-overall.ps1"), "utf8");
  const runtimeSync = readFileSync(resolve(root, "scripts", "sync-anticodex-runtime.ps1"), "utf8");
  const summarizer = readFileSync(resolve(root, "scripts", "summarize-anticodex-report.mjs"), "utf8");
  const diagnostics = readFileSync(resolve(root, "scripts", "test-anticodex-diagnostics.ps1"), "utf8");
  const goalReadiness = readFileSync(resolve(root, "scripts", "test-anticodex-goal-readiness.mjs"), "utf8");
  const optionalReports = Array.from(new Set(Array.from(releaseGates.matchAll(/\{[^}]*file:\s*"([^"]+\.json)"[^}]*requiredForRelease:\s*false[^}]*\}/g), (match) => match[1]))).sort();
  const specialReports = [
    "latest-antigravity-cli-profile-prepare.json",
    "latest-diagnostics.json",
    "latest-release-gates.json",
    "latest-shortcut-repair.json",
    "latest-ui-coding-project-smoke.json",
    "latest-ui-report-site-smoke.json",
    "latest-worker-mcp-server-probe.json",
  ];

  assert.deepEqual(optionalReports, [
    "latest-antigravity-cli-real-smoke.json",
    "latest-cold-relaunch.json",
    "latest-native-multi-tool-loop.json",
    "latest-native-tool-loop.json",
    "latest-provider-antigravity-return.json",
    "latest-real-third-party-provider.json",
    "latest-stability-soak.json",
  ]);
  for (const report of [...optionalReports, ...specialReports]) {
    assert.ok(collector.includes(report), `${report} missing from diagnostic bundle latestReports`);
    assert.ok(server.includes(report), `${report} missing from Manager latest reports`);
    assert.ok(installedOverall.includes(report), `${report} missing from installed overall report integrity list`);
  }
  assert.match(runtimeSync, /scripts\\test-anticodex-goal-readiness\.mjs/);
  assert.match(summarizer, /goalReadinessEvidence/);
  assert.match(collector, /goalReadinessEvidence = \$json\.goalReadinessEvidence/);
  assert.match(diagnostics, /goal-readiness summary missing goalReadinessEvidence/);
  assert.match(diagnostics, /goal-readiness summary unexpectedly claims goal complete/);
  assert.match(releaseGates, /id:\s*"goalReadiness"[\s\S]*?file:\s*"latest-goal-readiness\.json"[\s\S]*?requiredForRelease:\s*true/);
  assert.match(releaseGates, /requireGoalReadinessSemantics:\s*true/);
  assert.match(releaseGates, /goal_readiness_release_not_blocked_only_by_real_traffic/);
  assert.match(releaseGates, /scripts\/test-anticodex-goal-readiness\.mjs/);
  assert.match(goalReadiness, /reportName: "goal-readiness"/);
  assert.match(goalReadiness, /requestedRealTraffic: false/);
  assert.match(goalReadiness, /usedRealTraffic: false/);
  assert.match(goalReadiness, /codexClientCopy/);
  assert.match(goalReadiness, /workerMcp/);
  assert.match(goalReadiness, /passedServerCount/);
  assert.match(goalReadiness, /toolCountByServer/);
  assert.match(goalReadiness, /worker_mcp_tool_count_incomplete/);
  assert.match(collector, /worker-mcp-server-probe\.json/);
  assert.match(collector, /latest-worker-mcp-server-probe\.json/);
  assert.match(summarizer, /workerMcpServerProbeEvidence/);
  assert.match(diagnostics, /diagnostic reports summary missing latest-worker-mcp-server-probe\.json/);
  assert.match(diagnostics, /worker-mcp-server-probe summary missing workerMcpServerProbeEvidence/);
  assert.match(diagnostics, /mimo-claude-coworker/);
  assert.match(goalReadiness, /desktopAgenticTasks/);
  assert.match(goalReadiness, /agenticCapabilityMatrix/);
  assert.match(goalReadiness, /realTaskCoverageRoadmap/);
  assert.match(goalReadiness, /artifactProofTaskCount/);
  assert.match(goalReadiness, /missingArtifactProofTaskCount/);
  assert.match(goalReadiness, /real_task_artifact_proof_missing/);
  assert.match(goalReadiness, /resultProofTaskCount/);
  assert.match(goalReadiness, /missingResultProofTaskCount/);
  assert.match(goalReadiness, /real_task_result_proof_missing/);
  assert.match(goalReadiness, /latest-real-approval-plan\.json/);
  assert.match(goalReadiness, /realApprovalPlan/);
  assert.match(goalReadiness, /requiredReleaseRealTrafficActionCount/);
  assert.match(goalReadiness, /optionalReleaseRealTrafficActionCount/);
  assert.match(goalReadiness, /real_task_coverage_refresh_required/);
  assert.match(goalReadiness, /uniqueRefreshTasks/);
  assert.match(goalReadiness, /minimalRefreshCommandPresent/);
  assert.match(summarizer, /realTaskCoverageNextProfilesNeedingRealTraffic/);
  assert.match(summarizer, /realTaskCoverageArtifactProofComplete/);
  assert.match(summarizer, /realTaskCoverageResultProofComplete/);
  assert.match(summarizer, /realApprovalPlanRequiredReleaseActionCount/);
  assert.match(summarizer, /realApprovalPlanOptionalReleaseActionCount/);
  assert.match(diagnostics, /goal-readiness summary missing real-task coverage roadmap proof/);
  assert.match(diagnostics, /goal-readiness summary missing real-task artifact proof coverage/);
  assert.match(diagnostics, /goal-readiness summary missing real-task result proof coverage/);
  assert.match(diagnostics, /goal-readiness summary missing real-approval plan proof/);
  assert.match(diagnostics, /goal-readiness summary missing required real-approval release actions/);
  assert.match(goalReadiness, /antigravityAccountIsolation/);
  assert.match(goalReadiness, /latest-second-antigravity-account-login-entrypoint\.json/);
  assert.match(goalReadiness, /secondAccountLoginEntrypoint/);
  assert.match(goalReadiness, /approvedLoginCommandPresent/);
  assert.match(goalReadiness, /nextNoTrafficStatusCommandPresent/);
  assert.match(goalReadiness, /postLoginProofCommandPresent/);
  assert.match(goalReadiness, /approvedLoginCommandTemplate/);
  assert.match(goalReadiness, /nextNoTrafficStatusCommand/);
  assert.match(goalReadiness, /postLoginProofCommandTemplate/);
  assert.match(goalReadiness, /postLoginProofCommandTemplateHasWindowsUser/);
  assert.match(goalReadiness, /postLoginProofPlanValid/);
  assert.match(goalReadiness, /second_account_login_entrypoint_missing_or_invalid/);
  assert.match(goalReadiness, /latest-second-account-readiness-summary\.json/);
  assert.match(goalReadiness, /secondAccountReadinessSummary/);
  assert.match(goalReadiness, /readyForOperatorLogin/);
  assert.match(goalReadiness, /nextOperatorAction/);
  assert.match(goalReadiness, /manualSetupCommandHint/);
  assert.match(goalReadiness, /operatorChecklistOrderOk/);
  assert.match(goalReadiness, /operatorChecklistStartsLoginCount/);
  assert.match(goalReadiness, /operatorChecklistUsesRealTrafficCount/);
  assert.match(goalReadiness, /accountIsolationCaveat/);
  assert.match(goalReadiness, /second_account_readiness_summary_missing_or_invalid/);
  assert.match(releaseGates, /goal_readiness_second_account_entrypoint_proof_plan_invalid/);
  assert.match(releaseGates, /goal_readiness_second_account_entrypoint_login_template_incomplete/);
  assert.match(releaseGates, /goal_readiness_second_account_readiness_summary_missing_or_invalid/);
  assert.match(releaseGates, /goal_readiness_second_account_readiness_summary_checklist_order/);
  assert.match(releaseGates, /goal_readiness_second_account_readiness_summary_manual_hint_missing/);
  assert.match(summarizer, /secondAccountLoginEntrypointProven/);
  assert.match(summarizer, /secondAccountLoginEntrypointApprovedLoginCommandPresent/);
  assert.match(summarizer, /secondAccountLoginEntrypointApprovedLoginCommandTemplate/);
  assert.match(summarizer, /secondAccountReadinessSummaryProven/);
  assert.match(summarizer, /secondAccountReadinessSummaryNextOperatorAction/);
  assert.match(summarizer, /secondAccountReadinessSummaryAccountIsolationCaveat/);
  assert.match(diagnostics, /goal-readiness summary missing second-account login entrypoint proof/);
  assert.match(diagnostics, /goal-readiness summary second-account entrypoint proof plan invalid/);
  assert.match(diagnostics, /goal-readiness summary missing second-account readiness summary proof/);
  assert.match(diagnostics, /goal-readiness summary second-account readiness summary caveat missing/);
  assert.match(goalReadiness, /releaseBlockedOnlyByRequiredRealTraffic/);
});

test("Anti-Codex ships a no-traffic real task coverage roadmap", () => {
  const roadmap = readFileSync(resolve(root, "scripts", "test-anticodex-real-task-coverage-roadmap.mjs"), "utf8");
  const summarizer = readFileSync(resolve(root, "scripts", "summarize-anticodex-report.mjs"), "utf8");
  const collector = readFileSync(resolve(root, "scripts", "collect-anticodex-diagnostics.ps1"), "utf8");
  const diagnostics = readFileSync(resolve(root, "scripts", "test-anticodex-diagnostics.ps1"), "utf8");
  const runtimeSync = readFileSync(resolve(root, "scripts", "sync-anticodex-runtime.ps1"), "utf8");
  const releaseGates = readFileSync(resolve(root, "scripts", "test-anticodex-release-gates.mjs"), "utf8");
  const installedOverall = readFileSync(resolve(root, "scripts", "test-anticodex-installed-overall.ps1"), "utf8");
  const server = readFileSync(resolve(root, "translator", "adaptive-server.mjs"), "utf8");
  const managerBridge = readFileSync(resolve(root, "scripts", "anticodex-manager-bridge.mjs"), "utf8");
  const managerInject = readFileSync(resolve(root, "scripts", "anticodex-manager-inject.js"), "utf8");

  assert.match(roadmap, /reportName: "real-task-coverage-roadmap"/);
  assert.match(roadmap, /requestedRealTraffic: false/);
  assert.match(roadmap, /usedRealTraffic: false/);
  assert.match(roadmap, /requiredProfiles/);
  assert.match(roadmap, /extended/);
  assert.match(roadmap, /all/);
  assert.match(roadmap, /approvalRequiredForRefresh/);
  assert.match(roadmap, /uniqueRefreshTasks/);
  assert.match(roadmap, /pendingRealTaskScenarios/);
  assert.match(roadmap, /realTrafficRequired/);
  assert.match(roadmap, /acceptanceEvidence/);
  assert.match(roadmap, /expectedResult/);
  assert.match(roadmap, /workType/);
  assert.match(roadmap, /minimalRefreshCommand/);
  assert.match(roadmap, /minimalRefreshCommandArgs/);
  assert.match(roadmap, /refreshApprovalSummary/);
  assert.match(roadmap, /--tasks/);
  assert.match(roadmap, /test-anticodex-desktop-task-suite\.mjs --suite-profile/);
  assert.match(roadmap, /taskArtifactRequirements/);
  assert.match(roadmap, /artifactEvidenceKeys/);
  assert.match(roadmap, /artifactProofCount/);
  assert.match(roadmap, /missingArtifactProofKeys/);
  assert.match(roadmap, /taskResultRequirements/);
  assert.match(roadmap, /assistantHasFinalMarker/);
  assert.match(roadmap, /markerToolOutputSeen/);
  assert.match(roadmap, /visibleProgressCount/);
  assert.match(roadmap, /taskToolCallCount/);
  assert.match(roadmap, /taskToolOutputSeen/);
  assert.match(roadmap, /resultEvidenceKeys/);
  assert.match(roadmap, /resultProofCount/);
  assert.match(roadmap, /missingResultProofKeys/);
  assert.match(roadmap, /artifactProofCompleteCount/);
  assert.match(roadmap, /resultProofCompleteCount/);
  assert.match(roadmap, /missingResultProofTasks/);
  assert.match(roadmap, /profileResultProofComplete/);
  assert.match(roadmap, /repo-multi-file-edit/);
  assert.match(roadmap, /htmlComplete/);
  assert.match(summarizer, /realTaskCoverageRoadmapEvidence/);
  assert.match(summarizer, /minimalRefreshCommandPresent/);
  assert.match(summarizer, /uniqueRefreshTasks/);
  assert.match(summarizer, /taskArtifactProofs/);
  assert.match(summarizer, /missingArtifactProofTaskCount/);
  assert.match(summarizer, /taskResultProofs/);
  assert.match(summarizer, /missingResultProofTaskCount/);
  assert.match(summarizer, /profileResultProofComplete/);
  assert.match(summarizer, /pendingRealTaskScenarios/);
  assert.match(summarizer, /expectedResultPresent/);
  assert.match(collector, /realTaskCoverageRoadmapEvidence = \$json\.realTaskCoverageRoadmapEvidence/);
  assert.match(diagnostics, /real-task-coverage-roadmap summary missing realTaskCoverageRoadmapEvidence/);
  assert.match(diagnostics, /real-task-coverage-roadmap summary missing minimal refresh command/);
  assert.match(diagnostics, /real-task-coverage-roadmap summary missing pending real task scenarios/);
  assert.match(diagnostics, /real-task-coverage-roadmap summary pending scenario missing expected result/);
  assert.match(diagnostics, /real-task-coverage-roadmap summary missing artifact proof coverage/);
  assert.match(diagnostics, /real-task-coverage-roadmap summary missing artifact proof count/);
  assert.match(diagnostics, /real-task-coverage-roadmap summary missing result proof coverage/);
  assert.match(diagnostics, /real-task-coverage-roadmap summary missing result proof count/);
  assert.match(diagnostics, /real-task-coverage-roadmap summary profile \$profileName result proof incomplete/);
  assert.match(runtimeSync, /scripts\\test-anticodex-real-task-coverage-roadmap\.mjs/);
  assert.match(releaseGates, /id:\s*"realTaskCoverageRoadmap"[\s\S]*?file:\s*"latest-real-task-coverage-roadmap\.json"[\s\S]*?requiredForRelease:\s*true/);
  assert.match(releaseGates, /requireRealTaskCoverageRoadmapSemantics:\s*true/);
  assert.match(releaseGates, /real_task_coverage_roadmap_minimal_refresh_command_not_real_traffic/);
  assert.match(releaseGates, /real_task_coverage_roadmap_minimal_refresh_command_args_missing/);
  assert.match(releaseGates, /real_task_coverage_roadmap_refresh_approval_summary_missing/);
  assert.match(releaseGates, /real_task_coverage_roadmap_artifact_proof_missing/);
  assert.match(releaseGates, /real_task_coverage_roadmap_result_proof_missing/);
  assert.match(releaseGates, /real_task_coverage_roadmap_\$\{profileName\}_result_profile_incomplete/);
  assert.match(releaseGates, /scripts\/test-anticodex-real-task-coverage-roadmap\.mjs/);
  assert.match(installedOverall, /latest-real-task-coverage-roadmap\.json/);
  assert.match(server, /latest-real-task-coverage-roadmap\.json/);
  assert.match(managerBridge, /realTaskCoverage next:/);
  assert.match(managerBridge, /realTaskCoverage scenarios:/);
  assert.match(managerInject, /realTaskCoverage next:/);
  assert.match(managerInject, /realTaskCoverage scenarios:/);
});

test("Anti-Codex ships a no-traffic real approval execution plan", () => {
  const plan = readFileSync(resolve(root, "scripts", "test-anticodex-real-approval-plan.mjs"), "utf8");
  const summarizer = readFileSync(resolve(root, "scripts", "summarize-anticodex-report.mjs"), "utf8");
  const collector = readFileSync(resolve(root, "scripts", "collect-anticodex-diagnostics.ps1"), "utf8");
  const diagnostics = readFileSync(resolve(root, "scripts", "test-anticodex-diagnostics.ps1"), "utf8");
  const runtimeSync = readFileSync(resolve(root, "scripts", "sync-anticodex-runtime.ps1"), "utf8");
  const installedOverall = readFileSync(resolve(root, "scripts", "test-anticodex-installed-overall.ps1"), "utf8");
  const signer = readFileSync(resolve(root, "scripts", "sign-anticodex-reports.mjs"), "utf8");
  const server = readFileSync(resolve(root, "translator", "adaptive-server.mjs"), "utf8");
  const releaseGates = readFileSync(resolve(root, "scripts", "test-anticodex-release-gates.mjs"), "utf8");
  const managerBridge = readFileSync(resolve(root, "scripts", "anticodex-manager-bridge.mjs"), "utf8");
  const managerInject = readFileSync(resolve(root, "scripts", "anticodex-manager-inject.js"), "utf8");

  assert.match(plan, /reportName: "real-approval-plan"/);
  assert.match(plan, /requestedRealTraffic: false/);
  assert.match(plan, /usedRealTraffic: false/);
  assert.match(plan, /realTaskRefresh/);
  assert.match(plan, /commandArgs/);
  assert.match(plan, /approvalSummary/);
  assert.match(plan, /function asObjectArray/);
  assert.match(plan, /pendingRealTaskScenarios/);
  assert.match(plan, /expectedResultPresent/);
  assert.match(plan, /releaseRealTrafficGates/);
  assert.match(plan, /preLoginChecklist/);
  assert.match(plan, /preLoginChecklistComplete/);
  assert.match(plan, /latest-second-antigravity-account-login-entrypoint\.json/);
  assert.match(plan, /approvedLoginCommand/);
  assert.match(plan, /postLoginProofCommand/);
  assert.match(plan, /windows-user-account-prepare/);
  assert.match(plan, /account-isolation-status/);
  assert.match(plan, /second-account-login-entrypoint-status/);
  assert.match(plan, /requiredActions/);
  assert.match(plan, /optionalActions/);
  assert.match(plan, /requiredReleaseRealTrafficActionCount/);
  assert.match(plan, /optionalReleaseRealTrafficActionCount/);
  assert.match(plan, /accountIsolation/);
  assert.match(plan, /blockedUntilExplicitUserApproval/);
  assert.match(plan, /target_windows_user_missing/);
  assert.match(plan, /uniqueRefreshTasks/);
  assert.match(summarizer, /realApprovalPlanEvidence/);
  assert.match(summarizer, /requiredReleaseRealTrafficActionCount/);
  assert.match(summarizer, /optionalReleaseRealTrafficActionCount/);
  assert.match(summarizer, /realTaskRefreshPendingScenarios/);
  assert.match(summarizer, /preLoginChecklistComplete/);
  assert.match(summarizer, /preLoginChecklistIds/);
  assert.match(collector, /latest-real-approval-plan\.json/);
  assert.match(collector, /realApprovalPlanEvidence = \$json\.realApprovalPlanEvidence/);
  assert.match(diagnostics, /real-approval-plan summary missing realApprovalPlanEvidence/);
  assert.match(diagnostics, /real-approval-plan summary missing required release real-traffic actions/);
  assert.match(diagnostics, /real-approval-plan summary missing real task refresh scenarios/);
  assert.match(diagnostics, /real-approval-plan summary refresh scenario missing expected result/);
  assert.match(diagnostics, /real-approval-plan summary missing optional release real-traffic action count/);
  assert.match(diagnostics, /real-approval-plan summary missing complete pre-login checklist/);
  assert.match(diagnostics, /real-approval-plan summary missing pre-login checklist id/);
  assert.match(managerBridge, /realApprovalPlan preLogin/);
  assert.match(managerInject, /realApprovalPlan preLogin/);
  assert.match(runtimeSync, /scripts\\test-anticodex-real-approval-plan\.mjs/);
  assert.match(releaseGates, /id:\s*"realApprovalPlan"[\s\S]*?file:\s*"latest-real-approval-plan\.json"[\s\S]*?requiredForRelease:\s*true/);
  assert.match(releaseGates, /requireRealApprovalPlanSemantics:\s*true/);
  assert.match(releaseGates, /real_approval_plan_required_release_actions_missing/);
  assert.match(releaseGates, /real_approval_plan_refresh_command_args_missing/);
  assert.match(releaseGates, /real_approval_plan_refresh_approval_summary_missing/);
  assert.match(releaseGates, /real_approval_plan_pre_login_checklist_incomplete/);
  assert.match(releaseGates, /real_approval_plan_second_account_entrypoint_source_missing/);
  assert.match(releaseGates, /real_approval_plan_login_action_missing_windows_user/);
  assert.match(releaseGates, /real_approval_plan_proof_action_missing_separate_account_flag/);
  assert.match(releaseGates, /real_approval_plan_pre_login_\$\{checklistId\.replaceAll\("-", "_"\)\}_missing/);
  assert.match(releaseGates, /scripts\/test-anticodex-real-approval-plan\.mjs/);
  assert.match(installedOverall, /latest-real-approval-plan\.json/);
  assert.match(signer, /latest-real-approval-plan\.json/);
  assert.match(server, /latest-real-approval-plan\.json/);
});

test("Anti-Codex ships a no-traffic required real traffic sequence verifier", () => {
  const sequence = readFileSync(resolve(root, "scripts", "test-anticodex-required-real-traffic-sequence.ps1"), "utf8");
  const runtimeSync = readFileSync(resolve(root, "scripts", "sync-anticodex-runtime.ps1"), "utf8");
  const collector = readFileSync(resolve(root, "scripts", "collect-anticodex-diagnostics.ps1"), "utf8");
  const installedOverall = readFileSync(resolve(root, "scripts", "test-anticodex-installed-overall.ps1"), "utf8");
  const signer = readFileSync(resolve(root, "scripts", "sign-anticodex-reports.mjs"), "utf8");
  const server = readFileSync(resolve(root, "translator", "adaptive-server.mjs"), "utf8");
  const releaseGates = readFileSync(resolve(root, "scripts", "test-anticodex-release-gates.mjs"), "utf8");
  const summarizer = readFileSync(resolve(root, "scripts", "summarize-anticodex-report.mjs"), "utf8");
  const diagnostics = readFileSync(resolve(root, "scripts", "test-anticodex-diagnostics.ps1"), "utf8");

  assert.match(sequence, /reportName\s*=\s*"required-real-traffic-sequence"/);
  assert.match(sequence, /requestedRealTraffic\s*=\s*\$false/);
  assert.match(sequence, /usedRealTraffic\s*=\s*\$false/);
  assert.match(sequence, /latest-real-approval-plan\.json/);
  assert.match(sequence, /requiredActions/);
  assert.match(sequence, /optionalActions/);
  assert.match(sequence, /noOptionalActionsInRequiredSequence/);
  assert.match(sequence, /blockedUntilExplicitUserApproval/);
  assert.match(sequence, /requiredActionCount/);
  assert.match(sequence, /optionalActionCount/);
  assert.match(releaseGates, /requireRequiredRealTrafficSequenceSemantics/);
  assert.match(releaseGates, /required_real_traffic_sequence_optional_actions_mixed/);
  assert.match(releaseGates, /scripts\/test-anticodex-required-real-traffic-sequence\.ps1/);
  assert.match(summarizer, /requiredRealTrafficSequenceEvidence/);
  assert.match(collector, /requiredRealTrafficSequenceEvidence = \$json\.requiredRealTrafficSequenceEvidence/);
  assert.match(diagnostics, /required-real-traffic-sequence summary missing requiredRealTrafficSequenceEvidence/);
  assert.match(diagnostics, /required-real-traffic-sequence summary mixed optional actions/);
  assert.match(runtimeSync, /scripts\\test-anticodex-required-real-traffic-sequence\.ps1/);
  assert.match(collector, /latest-required-real-traffic-sequence\.json/);
  assert.match(installedOverall, /latest-required-real-traffic-sequence\.json/);
  assert.match(signer, /latest-required-real-traffic-sequence\.json/);
  assert.match(server, /latest-required-real-traffic-sequence\.json/);
});

test("Anti-Codex ships a no-traffic native Codex parity task matrix", () => {
  const matrix = readFileSync(resolve(root, "scripts", "test-anticodex-native-codex-parity-tasks.mjs"), "utf8");
  const summarizer = readFileSync(resolve(root, "scripts", "summarize-anticodex-report.mjs"), "utf8");
  const collector = readFileSync(resolve(root, "scripts", "collect-anticodex-diagnostics.ps1"), "utf8");
  const diagnostics = readFileSync(resolve(root, "scripts", "test-anticodex-diagnostics.ps1"), "utf8");
  const runtimeSync = readFileSync(resolve(root, "scripts", "sync-anticodex-runtime.ps1"), "utf8");
  const installedOverall = readFileSync(resolve(root, "scripts", "test-anticodex-installed-overall.ps1"), "utf8");
  const signer = readFileSync(resolve(root, "scripts", "sign-anticodex-reports.mjs"), "utf8");
  const server = readFileSync(resolve(root, "translator", "adaptive-server.mjs"), "utf8");
  const releaseGates = readFileSync(resolve(root, "scripts", "test-anticodex-release-gates.mjs"), "utf8");
  const managerBridge = readFileSync(resolve(root, "scripts", "anticodex-manager-bridge.mjs"), "utf8");
  const managerInject = readFileSync(resolve(root, "scripts", "anticodex-manager-inject.js"), "utf8");

  assert.match(matrix, /reportName: "native-codex-parity-task-matrix"/);
  assert.match(matrix, /coverageKind: "native-codex-parity-task-matrix-report-only"/);
  assert.match(matrix, /requestedRealTraffic: false/);
  assert.match(matrix, /usedRealTraffic: false/);
  assert.match(matrix, /nativeCodexParityComplete/);
  assert.match(matrix, /parityGroups/);
  assert.match(matrix, /conversation/);
  assert.match(matrix, /research/);
  assert.match(matrix, /projectCreation/);
  assert.match(matrix, /codingAndRepoEditing/);
  assert.match(matrix, /multiTurnAgentic/);
  assert.match(matrix, /toolUse/);
  assert.match(matrix, /free-chat/);
  assert.match(matrix, /web-search/);
  assert.match(matrix, /repo-multi-file-edit/);
  assert.match(matrix, /pendingRealTaskScenarios/);
  assert.match(matrix, /realTrafficStillRequired/);
  assert.match(matrix, /minimalRefreshCommandArgs/);
  assert.match(summarizer, /nativeCodexParityTaskMatrixEvidence/);
  assert.match(collector, /nativeCodexParityTaskMatrixEvidence = \$json\.nativeCodexParityTaskMatrixEvidence/);
  assert.match(diagnostics, /native-codex-parity-task-matrix summary missing nativeCodexParityTaskMatrixEvidence/);
  assert.match(diagnostics, /native-codex-parity-task-matrix summary missing pending real task scenarios/);
  assert.match(runtimeSync, /scripts\\test-anticodex-native-codex-parity-tasks\.mjs/);
  assert.match(installedOverall, /latest-native-codex-parity-task-matrix\.json/);
  assert.match(signer, /latest-native-codex-parity-task-matrix\.json/);
  assert.match(server, /latest-native-codex-parity-task-matrix\.json/);
  assert.match(releaseGates, /id:\s*"nativeCodexParityTaskMatrix"[\s\S]*?file:\s*"latest-native-codex-parity-task-matrix\.json"[\s\S]*?requiredForRelease:\s*true/);
  assert.match(releaseGates, /requireNativeCodexParityTaskMatrixSemantics:\s*true/);
  assert.match(releaseGates, /native_codex_parity_task_matrix_pending_task_modes_missing/);
  assert.match(managerBridge, /nativeParity: complete=/);
  assert.match(managerInject, /nativeParity: complete=/);
});

test("Anti-Codex ships a no-traffic long task landing matrix verifier", () => {
  const matrix = readFileSync(resolve(root, "scripts", "test-anticodex-long-task-landing-matrix.mjs"), "utf8");
  const runtimeSync = readFileSync(resolve(root, "scripts", "sync-anticodex-runtime.ps1"), "utf8");
  const collector = readFileSync(resolve(root, "scripts", "collect-anticodex-diagnostics.ps1"), "utf8");
  const diagnostics = readFileSync(resolve(root, "scripts", "test-anticodex-diagnostics.ps1"), "utf8");
  const installedOverall = readFileSync(resolve(root, "scripts", "test-anticodex-installed-overall.ps1"), "utf8");
  const signer = readFileSync(resolve(root, "scripts", "sign-anticodex-reports.mjs"), "utf8");
  const summarizer = readFileSync(resolve(root, "scripts", "summarize-anticodex-report.mjs"), "utf8");
  const server = readFileSync(resolve(root, "translator", "adaptive-server.mjs"), "utf8");
  const releaseGates = readFileSync(resolve(root, "scripts", "test-anticodex-release-gates.mjs"), "utf8");

  assert.match(matrix, /reportName: "long-task-landing-matrix"/);
  assert.match(matrix, /coverageKind: "long-task-landing-matrix-report-only"/);
  assert.match(matrix, /requestedRealTraffic: false/);
  assert.match(matrix, /usedRealTraffic: false/);
  assert.match(matrix, /requiredLongTasks/);
  assert.match(matrix, /coding-project/);
  assert.match(matrix, /multi-turn-project/);
  assert.match(matrix, /report-site/);
  assert.match(matrix, /complex-project/);
  assert.match(matrix, /repo-multi-file-edit/);
  assert.match(matrix, /requiredResponseHistoryKeys/);
  assert.match(matrix, /responseHistoryEvidence/);
  assert.match(matrix, /assistantHasFinalMarker/);
  assert.match(matrix, /markerToolOutputSeen/);
  assert.match(matrix, /visibleProgressCount/);
  assert.match(matrix, /taskToolCallCount/);
  assert.match(matrix, /taskToolOutputSeen/);
  assert.match(matrix, /agenticCapabilityMatrix/);
  assert.match(matrix, /realTaskCoverageRoadmap/);
  assert.match(matrix, /longTaskLandingComplete/);
  assert.match(matrix, /codexClientCopy: true/);
  assert.match(matrix, /antigravityModelTextOnly: true/);
  assert.match(matrix, /latest-long-task-landing-matrix\.json/);
  assert.match(summarizer, /longTaskLandingMatrixEvidence/);
  assert.match(collector, /longTaskLandingMatrixEvidence = \$json\.longTaskLandingMatrixEvidence/);
  assert.match(collector, /latest-long-task-landing-matrix\.json/);
  assert.match(diagnostics, /long-task-landing-matrix summary missing longTaskLandingMatrixEvidence/);
  assert.match(diagnostics, /long-task-landing-matrix summary task \$taskMode not ok/);
  assert.match(runtimeSync, /scripts\\test-anticodex-long-task-landing-matrix\.mjs/);
  assert.match(installedOverall, /latest-long-task-landing-matrix\.json/);
  assert.match(signer, /latest-long-task-landing-matrix\.json/);
  assert.match(server, /latest-long-task-landing-matrix\.json/);
  assert.match(releaseGates, /id:\s*"longTaskLandingMatrix"[\s\S]*?file:\s*"latest-long-task-landing-matrix\.json"[\s\S]*?requiredForRelease:\s*true/);
  assert.match(releaseGates, /requireLongTaskLandingMatrixSemantics:\s*true/);
  assert.match(releaseGates, /long_task_landing_matrix_landed_count/);
  assert.match(releaseGates, /node scripts\\\\test-anticodex-long-task-landing-matrix\.mjs/);
});

test("Anti-Codex ships a no-traffic CLI model transport boundary verifier", () => {
  const boundary = readFileSync(resolve(root, "scripts", "test-anticodex-cli-transport-boundary.mjs"), "utf8");
  const runtimeSync = readFileSync(resolve(root, "scripts", "sync-anticodex-runtime.ps1"), "utf8");
  const collector = readFileSync(resolve(root, "scripts", "collect-anticodex-diagnostics.ps1"), "utf8");
  const diagnostics = readFileSync(resolve(root, "scripts", "test-anticodex-diagnostics.ps1"), "utf8");
  const installedOverall = readFileSync(resolve(root, "scripts", "test-anticodex-installed-overall.ps1"), "utf8");
  const signer = readFileSync(resolve(root, "scripts", "sign-anticodex-reports.mjs"), "utf8");
  const summarizer = readFileSync(resolve(root, "scripts", "summarize-anticodex-report.mjs"), "utf8");
  const server = readFileSync(resolve(root, "translator", "adaptive-server.mjs"), "utf8");
  const releaseGates = readFileSync(resolve(root, "scripts", "test-anticodex-release-gates.mjs"), "utf8");

  assert.match(boundary, /reportName: "cli-transport-boundary"/);
  assert.match(boundary, /requestedRealTraffic: false/);
  assert.match(boundary, /usedRealTraffic: false/);
  assert.match(boundary, /coverageKind: "cli-transport-boundary-report-only"/);
  assert.match(boundary, /modelTextTransport: String\(health\.modelTextTransport \|\| ""\)/);
  assert.match(boundary, /modelDiscoverySource: String\(health\.modelDiscoverySource \|\| ""\)/);
  assert.match(boundary, /antigravityDesktopRequiredForCliTransport: false/);
  assert.match(boundary, /antigravityDesktopProcessAbsenceRequired: false/);
  assert.match(boundary, /codexOwnedTools: true/);
  assert.match(boundary, /antigravityModelTextOnly: true/);
  assert.match(boundary, /health-model-text-transport-cli/);
  assert.match(boundary, /health-model-discovery-cli-catalog/);
  assert.match(boundary, /health-antigravity-coworker-disabled/);
  assert.match(boundary, /latest-cli-transport-boundary\.json/);
  assert.match(summarizer, /cliTransportBoundaryEvidence/);
  assert.match(summarizer, /antigravityDesktopRequiredForCliTransport/);
  assert.match(summarizer, /antigravityDesktopProcessAbsenceRequired/);
  assert.match(collector, /cliTransportBoundaryEvidence = \$json\.cliTransportBoundaryEvidence/);
  assert.match(collector, /latest-cli-transport-boundary\.json/);
  assert.match(diagnostics, /cli-transport-boundary summary missing cliTransportBoundaryEvidence/);
  assert.match(diagnostics, /cli-transport-boundary summary model transport is not cli/);
  assert.match(runtimeSync, /scripts\\test-anticodex-cli-transport-boundary\.mjs/);
  assert.match(installedOverall, /latest-cli-transport-boundary\.json/);
  assert.match(signer, /latest-cli-transport-boundary\.json/);
  assert.match(server, /latest-cli-transport-boundary\.json/);
  assert.match(releaseGates, /id:\s*"cliTransportBoundary"[\s\S]*?file:\s*"latest-cli-transport-boundary\.json"[\s\S]*?requiredForRelease:\s*true/);
  assert.match(releaseGates, /requireCliTransportBoundarySemantics:\s*true/);
  assert.match(releaseGates, /cli_transport_boundary_model_text_transport_not_cli/);
  assert.match(releaseGates, /cli_transport_boundary_desktop_required/);
  assert.match(releaseGates, /node scripts\\\\test-anticodex-cli-transport-boundary\.mjs/);
});

test("Anti-Codex ships a no-traffic goal real run readiness verifier", () => {
  const readiness = readFileSync(resolve(root, "scripts", "test-anticodex-goal-real-run-readiness.mjs"), "utf8");
  const runtimeSync = readFileSync(resolve(root, "scripts", "sync-anticodex-runtime.ps1"), "utf8");
  const collector = readFileSync(resolve(root, "scripts", "collect-anticodex-diagnostics.ps1"), "utf8");
  const installedOverall = readFileSync(resolve(root, "scripts", "test-anticodex-installed-overall.ps1"), "utf8");
  const signer = readFileSync(resolve(root, "scripts", "sign-anticodex-reports.mjs"), "utf8");
  const server = readFileSync(resolve(root, "translator", "adaptive-server.mjs"), "utf8");
  const releaseGates = readFileSync(resolve(root, "scripts", "test-anticodex-release-gates.mjs"), "utf8");
  const summarizer = readFileSync(resolve(root, "scripts", "summarize-anticodex-report.mjs"), "utf8");
  const diagnostics = readFileSync(resolve(root, "scripts", "test-anticodex-diagnostics.ps1"), "utf8");
  const managerBridge = readFileSync(resolve(root, "scripts", "anticodex-manager-bridge.mjs"), "utf8");
  const managerInject = readFileSync(resolve(root, "scripts", "anticodex-manager-inject.js"), "utf8");

  assert.match(readiness, /reportName: "goal-real-run-readiness"/);
  assert.match(readiness, /requestedRealTraffic: false/);
  assert.match(readiness, /usedRealTraffic: false/);
  assert.match(readiness, /coverageKind: "goal-real-run-readiness-report-only"/);
  assert.match(readiness, /readyForUserApprovedRealRun: false/);
  assert.match(readiness, /pendingRealTaskScenarios/);
  assert.match(readiness, /uniqueRefreshTasks/);
  assert.match(readiness, /web-search/);
  assert.match(readiness, /free-chat/);
  assert.match(readiness, /second_account_login_not_ready/);
  assert.match(readiness, /real_task_refresh_requires_explicit_approval/);
  assert.match(readiness, /release_gates_require_explicit_real_traffic/);
  assert.match(readiness, /accountProxyReadiness/);
  assert.match(readiness, /postVerification/);
  assert.match(summarizer, /goalRealRunReadinessEvidence/);
  assert.match(summarizer, /readyForUserApprovedRealRun/);
  assert.match(summarizer, /pendingRealTaskScenarios/);
  assert.match(collector, /goalRealRunReadinessEvidence = \$json\.goalRealRunReadinessEvidence/);
  assert.match(collector, /latest-goal-real-run-readiness\.json/);
  assert.match(diagnostics, /goal-real-run-readiness summary missing goalRealRunReadinessEvidence/);
  assert.match(diagnostics, /goal-real-run-readiness summary missing refresh task \$taskMode/);
  assert.match(diagnostics, /goal-real-run-readiness summary missing blocked gate \$gateId/);
  assert.match(runtimeSync, /scripts\\test-anticodex-goal-real-run-readiness\.mjs/);
  assert.match(installedOverall, /latest-goal-real-run-readiness\.json/);
  assert.match(signer, /latest-goal-real-run-readiness\.json/);
  assert.match(server, /latest-goal-real-run-readiness\.json/);
  assert.match(managerBridge, /goalRealRun: ready=/);
  assert.match(managerBridge, /goalRealRun tasks:/);
  assert.match(managerInject, /goalRealRun: ready=/);
  assert.match(managerInject, /goalRealRun tasks:/);
  assert.match(releaseGates, /id:\s*"goalRealRunReadiness"[\s\S]*?file:\s*"latest-goal-real-run-readiness\.json"[\s\S]*?requiredForRelease:\s*true/);
  assert.match(releaseGates, /requireGoalRealRunReadinessSemantics:\s*true/);
  assert.match(releaseGates, /goal_real_run_readiness_web_search_task_missing/);
  assert.match(releaseGates, /goal_real_run_readiness_free_chat_task_missing/);
  assert.match(releaseGates, /goal_real_run_readiness_accountProxyReadiness_gate_missing/);
  assert.match(releaseGates, /semantically invalid goal-real-run-readiness report satisfied the gate/);
  assert.match(releaseGates, /node scripts\\\\test-anticodex-goal-real-run-readiness\.mjs/);
  assert.match(releaseGates, /scripts\/test-anticodex-goal-real-run-readiness\.mjs/);
});

test("Anti-Codex ships a read-only tool bridge mode verifier", () => {
  const toolBridge = readFileSync(resolve(root, "scripts", "test-anticodex-tool-bridge-mode.ps1"), "utf8");

  assert.match(toolBridge, /\/anticodex\/diagnostics/);
  assert.match(toolBridge, /toolBridge/);
  assert.match(toolBridge, /desktop-cascade/);
  assert.match(toolBridge, /native-mcp-same-cascade-with-prompt-fallback/);
  assert.match(toolBridge, /automatic-before-codex-execution/);
  assert.match(toolBridge, /nativeBridgeDefaultEnabled/);
  assert.match(toolBridge, /nativeAntigravityToolEvents/);
  assert.match(toolBridge, /acceptsExternalToolDefinitions/);
  assert.match(toolBridge, /nativeToolCapability/);
  assert.match(toolBridge, /externalToolDefinitionsField/);
  assert.match(toolBridge, /permissionPromptsDisabled/);
  assert.match(toolBridge, /tools\.bridge/);
  assert.match(toolBridge, /native_mcp_same_cascade/);
  assert.match(toolBridge, /ConvertTo-Json/);
  assert.doesNotMatch(toolBridge, /Stop-Process|Start-Process|auth\/login/);
});

test("tool bridge mode verifier bounds a silent diagnostics endpoint", async () => {
  const tempRoot = mkdtempSync(resolve(os.tmpdir(), "anticodex-tool-bridge-timeout-"));
  const server = http.createServer(() => {
    // Intentionally keep the request open until the verifier-side timeout fires.
  });
  await new Promise((resolveServer, rejectServer) => {
    server.once("error", rejectServer);
    server.listen(0, "127.0.0.1", resolveServer);
  });
  try {
    const port = server.address().port;
    const startedAt = Date.now();
    const result = spawnSync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy", "Bypass",
      "-File", resolve(root, "scripts", "test-anticodex-tool-bridge-mode.ps1"),
      "-TimeoutSec", "5",
      "-BaseUrl", `http://127.0.0.1:${port}`,
      "-ReportRoot", tempRoot,
    ], { encoding: "utf8", timeout: 12000 });
    const elapsedMs = Date.now() - startedAt;
    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.ok(elapsedMs < 10000, `tool bridge verifier took ${elapsedMs}ms`);
    const report = JSON.parse(readFileSync(resolve(tempRoot, "latest-tool-bridge-mode.json"), "utf8"));
    assert.equal(report.ok, false);
    assert.match(report.failures.join("\n"), /diagnostics request failed/);
    assert.equal(report.toolBridge, null);
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("Anti-Codex ships an account and proxy readiness verifier", () => {
  const readiness = readFileSync(resolve(root, "scripts", "test-anticodex-account-proxy-readiness.ps1"), "utf8");

  assert.match(readiness, /\/health/);
  assert.match(readiness, /\/anticodex\/account/);
  assert.match(readiness, /\/anticodex\/models\/refresh/);
  assert.match(readiness, /\/models/);
  assert.match(readiness, /\/v1\/responses/);
  assert.match(readiness, /\/responses/);
  assert.match(readiness, /streaming-fallback/);
  assert.match(readiness, /Invoke-LocalTextSafe/);
  assert.match(readiness, /StopPattern/);
  assert.match(readiness, /HttpWebRequest/);
  assert.match(readiness, /request\.Abort\(\)/);
  assert.match(readiness, /Remove-FailuresMatching/);
  assert.match(readiness, /\[int\]\$RequestAttempts = 3/);
  assert.match(readiness, /\[int\]\$TotalRequestTimeoutSec = 180/);
  assert.match(readiness, /configuredAttempts/);
  assert.match(readiness, /totalBudgetSec/);
  assert.match(readiness, /budgetExceeded/);
  assert.match(readiness, /realRequestAttemptCount/);
  assert.match(readiness, /accountProbeStaleButModelsAvailable -and \$realMarkerOk/);
  assert.match(readiness, /\/anticodex\/model-routes/);
  assert.match(readiness, /modelRouteAudit/);
  assert.match(readiness, /internalModel/);
  assert.match(readiness, /model route audit mismatch/);
  assert.doesNotMatch(readiness, /model route audit did not record an Antigravity internal model/);
  assert.match(readiness, /ACCOUNT_PROXY_READY_/);
  assert.match(readiness, /antigravity_temporarily_unavailable/);
  assert.match(readiness, /antigravity_account_unavailable/);
  assert.match(readiness, /account_verification_required/);
  assert.match(readiness, /account_verification_with_missing_token/);
  assert.match(readiness, /antigravity_oauth_network_failure/);
  assert.match(readiness, /diagnosisDetail/);
  assert.match(readiness, /detail = \$diagnosisDetail/);
  assert.match(readiness, /phaseSummary/);
  assert.match(readiness, /quota_or_limit_reached/);
  assert.match(readiness, /RESOURCE_EXHAUSTED\|Individual\\s\+quota\\s\+reached/);
  assert.match(readiness, /realRequestAttempted/);
  assert.match(readiness, /realRequestMode/);
  assert.match(readiness, /streamingFallbackAttempted/);
  assert.match(readiness, /realRequestError/);
  assert.match(readiness, /accountProbeStaleButModelsAvailable/);
  assert.match(readiness, /Test-NetworkTransientMessage/);
  assert.match(readiness, /underlying connection was closed/);
  assert.match(readiness, /if \(\$RequestError -or \$RefreshError\) \{ return "proxy_or_network_unavailable" \}/);
  assert.match(readiness, /Get-AntigravityLogSignals/);
  assert.match(readiness, /sourceFresh/);
  assert.match(readiness, /tokenRefreshMissingCount/);
  assert.match(readiness, /oauthNetworkFailureCount/);
  assert.match(readiness, /Tail 1000/);
  assert.match(readiness, /Verify your account to continue/);
  assert.match(readiness, /proxy_or_network/);
  assert.match(readiness, /account_signed_out_or_no_models/);
  assert.match(readiness, /local_gateway_offline/);
  assert.match(readiness, /Open Anti-Codex to start the local gateway/);
  assert.match(readiness, /AllowUnready/);
  assert.match(readiness, /localProxyBypassed/);
  assert.match(readiness, /identityAvailable/);
  assert.match(readiness, /Proxy\s*=\s*\$null/);
  assert.match(readiness, /\[Text\.Encoding\]::UTF8\.GetBytes/);
  assert.match(readiness, /ConvertTo-Json/);

  const releaseGates = readFileSync(resolve(root, "scripts", "test-anticodex-release-gates.mjs"), "utf8");
  assert.match(releaseGates, /accountProbeStaleButModelsAvailable && phaseSummary\.realRequestOk === true/);
  assert.match(releaseGates, /account_proxy_real_request_mode/);
  assert.match(releaseGates, /account_proxy_real_request_attempt_count/);

  assert.doesNotMatch(readiness, /Stop-Process/);
  assert.doesNotMatch(readiness, /Antigravity\.exe/);
  assert.doesNotMatch(readiness, /Codex\.exe/);
  assert.doesNotMatch(readiness, /chatgpt\.com/);
  assert.doesNotMatch(readiness, /auth\/login/);
  assert.doesNotMatch(readiness, /antigravityLogSignals\s*=\s*\$tail/);
});

test("Anti-Codex ships a full model routing verifier", () => {
  const routing = readFileSync(resolve(root, "scripts", "test-anticodex-model-routing.ps1"), "utf8");

  assert.match(routing, /\/anticodex\/models\/refresh/);
  assert.match(routing, /\/models/);
  assert.match(routing, /\/v1\/responses/);
  assert.match(routing, /\/anticodex\/model-routes/);
  assert.match(routing, /\[switch\]\$SkipRequests/);
  assert.match(routing, /\/anticodex\/diagnostics/);
  assert.match(routing, /diagnostics model count mismatch/);
  assert.match(routing, /\[int\]\$TimeoutSec = 20/);
  assert.match(routing, /Start-Sleep -Milliseconds/);
  assert.match(routing, /attempt \$attempt of \$MaxAttempts/);
  assert.match(routing, /\$modelRecords = if/);
  assert.match(routing, /display_name/);
  assert.match(routing, /\$diagnosticDisplayByModel = Get-ModelDisplayMap/);
  assert.match(routing, /\$models = @\(\$models\)/);
  assert.match(routing, /models request failed/);
  assert.match(routing, /display name is missing numeric model\/version detail/);
  assert.match(routing, /skippedRequest/);
  assert.match(routing, /MODEL_ROUTE_/);
  assert.match(routing, /resolved model mismatch/);
  assert.match(routing, /third-party model routing missing provider protocol/);
  assert.match(routing, /third-party provider model is present in \/models/);
  assert.match(routing, /third-party route transport mismatch/);
  assert.match(routing, /providerProtocol/);
  assert.match(routing, /providerModel/);
  assert.match(routing, /toolBridge/);
  assert.match(routing, /internalModel/);
  assert.match(routing, /\$route\.transport\s+-ne\s+"cli"\s+-and\s+-not\s+\[string\]\$route\.internalModel/);
  assert.match(routing, /cascadeId/);
  assert.match(routing, /route status is not success/);
  assert.match(routing, /latest-\$Name\.json/);
  assert.match(routing, /model-routing/);
  assert.match(routing, /Proxy\s*=\s*\$null/);
  assert.match(routing, /\[Text\.Encoding\]::UTF8\.GetBytes/);

  assert.doesNotMatch(routing, /Stop-Process/);
  assert.doesNotMatch(routing, /Antigravity\.exe/);
  assert.doesNotMatch(routing, /Codex\.exe/);
  assert.doesNotMatch(routing, /chatgpt\.com/);
  assert.doesNotMatch(routing, /auth\/login/);
});

test("Anti-Codex guards exact native thinking budgets after Codex sync", () => {
  const verifier = readFileSync(resolve(root, "scripts", "test-anticodex-model-thinking.ps1"), "utf8");
  const overall = readFileSync(resolve(root, "scripts", "test-anticodex-installed-overall.ps1"), "utf8");
  const readiness = readFileSync(resolve(root, "scripts", "test-anticodex-sync-readiness.ps1"), "utf8");

  assert.match(verifier, /gemini-3\.5-flash-low/);
  assert.match(verifier, /Gemini 3\.5 Flash \(Low\)/);
  assert.match(verifier, /thinking_budget/);
  assert.match(verifier, /min_thinking_budget/);
  assert.match(verifier, /claude-sonnet-4-6[\s\S]*min_thinking_budget = 32/);
  assert.match(verifier, /gpt-oss-120b-medium[\s\S]*min_thinking_budget = 32/);
  assert.match(verifier, /supports_thinking/);
  assert.match(verifier, /latest-model-thinking\.json/);
  assert.match(verifier, /Proxy\s*=\s*\$null/);
  assert.match(verifier, /UTF8Encoding\(\$false\)/);
  assert.doesNotMatch(verifier, /\/v1\/responses/);
  assert.doesNotMatch(verifier, /Stop-Process/);

  assert.match(overall, /test-anticodex-model-thinking\.ps1/);
  assert.match(overall, /Model thinking budget verification/);
  assert.match(readiness, /test-anticodex-model-thinking\.ps1/);
});

test("shared launcher handles unexpected exit of main process with bounded auto-restart and logs lifecycle events", () => {
  const launcher = readFileSync(resolve(root, "scripts", "start-deepcodex.ps1"), "utf8");

  // Verify lifecycle logging function and log path
  assert.match(launcher, /function Write-LifecycleLog/);
  assert.match(launcher, /deepcodex-lifecycle\.log/);

  // Verify log messages for all specified events
  assert.match(launcher, /"Main process started \(PID: [^"]*\)\."/);
  assert.match(launcher, /"Auto-restart succeeded \(PID: [^"]*\)\."/);
  assert.match(launcher, /"Normal window close detected\."/);
  assert.match(launcher, /"Main process exited unexpectedly \(ExitCode: [^"]*\)\."/);
  assert.match(launcher, /"Attempting auto-restart \(Attempt [^"]* of [^"]*\) after [^"]* seconds backoff\."/);
  assert.match(launcher, /"Auto-restart failed: max retry limit \([^"]*\) reached\."/);

  // Verify bounded retry limits and backoff configuration
  assert.match(launcher, /\$MAX_RESTARTS\s*=\s*\d+/);
  assert.match(launcher, /\$RESTART_BACKOFF_SECONDS\s*=\s*\d+/);
  assert.match(launcher, /\$RESTART_RESET_SECONDS\s*=\s*\d+/);
  assert.match(launcher, /restart counter reset after stable runtime/i);

  const windowReadyBlock = launcher.match(/if \(\$mainWindowHandle -ne \[IntPtr\]::Zero\) \{[\s\S]*?\n\s{8}\} else \{/)?.[0];
  assert.ok(windowReadyBlock, "missing main-window ready block");
  assert.match(windowReadyBlock, /Auto-restart succeeded/);
  assert.match(launcher, /ExitCode\s*-eq\s*0/);
  assert.match(launcher, /Window disappeared before a non-zero process exit/i);

  // Verify that watchdog runs inside the monitor loop
  const monitorLoop = launcher.match(/while \(-not \$codexProc\.HasExited\) \{[\s\S]*?\n\s{4,12}\}/)?.[0];
  assert.ok(monitorLoop, "missing monitor loop");
  assert.match(monitorLoop, /Ensure-TranslatorRunning/);
});

test("Anti-Codex selects third-party upstream without changing its persistent state root", () => {
  const launcher = readFileSync(resolve(root, "scripts", "start-anticodex.ps1"), "utf8");
  const sharedLauncher = readFileSync(resolve(root, "scripts", "start-deepcodex.ps1"), "utf8");
  const manager = readFileSync(resolve(root, "scripts", "manage-anticodex.ps1"), "utf8");

  assert.match(launcher, /anticodex-upstream-profile\.ps1/);
  assert.match(launcher, /-Action GetRuntime/);
  assert.match(launcher, /TRANSLATOR_UPSTREAM_MODE\s*=\s*"chat"/);
  assert.match(launcher, /UPSTREAM_PROTOCOL/);
  assert.match(launcher, /UPSTREAM_MODEL/);
  assert.match(launcher, /UPSTREAM_API_KEY/);
  assert.match(launcher, /if \(\$antiCodexUsesAntigravity\)/);
  assert.match(launcher, /third-party API profile; Antigravity Desktop is not required/);
  assert.match(launcher, /Test-AntiCodexTranslatorMatchesConfiguredUpstream/);
  assert.match(launcher, /upstream profile could not be read; refusing to fall back to Antigravity/);
  assert.doesNotMatch(launcher, /upstream profile could not be read; using Antigravity/);
  assert.match(launcher, /DEEPCODEX_STATE_ROOT\s*=\s*Join-Path \$env:APPDATA "anticodex"/);
  assert.doesNotMatch(launcher, /third-party[\s\S]{0,500}DEEPCODEX_STATE_ROOT\s*=/);

  assert.match(sharedLauncher, /\$USES_ANTIGRAVITY_UPSTREAM/);
  assert.match(sharedLauncher, /function Update-AntiCodexUpstreamEnvironment/);
  assert.match(sharedLauncher, /Set-AntiCodexAntigravityCliEnvironment/);
  assert.match(sharedLauncher, /ANTICODEX_ANTIGRAVITY_CLI_ISOLATE_WINDOWS_APPDATA/);
  assert.match(sharedLauncher, /strictWindowsAppDataIsolation/);
  assert.match(sharedLauncher, /refusing silent Antigravity fallback/);
  assert.doesNotMatch(sharedLauncher, /upstream profile could not be read; using Antigravity/);
  assert.match(sharedLauncher, /function Start-TranslatorProcess \{[\s\S]*?Update-AntiCodexUpstreamEnvironment/);
  assert.match(sharedLauncher, /\$translatorWatchNext = \[DateTime\]::UtcNow\.AddSeconds\(5\)[\s\S]*?Update-AntiCodexUpstreamEnvironment/);
  assert.match(sharedLauncher, /if \(\$USES_ANTIGRAVITY_UPSTREAM\)/);
  assert.match(sharedLauncher, /elseif \(\$env:UPSTREAM_API_KEY\)/);
  const antigravityWatchdog = sharedLauncher.match(/function Ensure-AntigravityDesktopRunning \{[\s\S]*?\n\}/)?.[0];
  assert.ok(antigravityWatchdog, "missing Antigravity watchdog");
  assert.match(antigravityWatchdog, /if \(-not \(Test-AntiCodexRequiresAntigravityDesktop\)\) \{ return \$true \}/);
  assert.match(sharedLauncher, /if \(\$USES_ANTIGRAVITY_UPSTREAM -and \[DateTime\]::UtcNow -ge \$antigravityCatalogWatchNext\)/);
  assert.match(manager, /anticodex-upstream-profile\.ps1/);
  assert.match(manager, /ANTICODEX_ACTIVE_UPSTREAM/);
});

test("embedded Manager exposes secure third-party API testing and switching", () => {
  const inject = readFileSync(resolve(root, "scripts", "anticodex-manager-inject.js"), "utf8");
  const server = readFileSync(resolve(root, "translator", "adaptive-server.mjs"), "utf8");
  const profile = readFileSync(resolve(root, "scripts", "anticodex-upstream-profile.ps1"), "utf8");

  assert.match(inject, /\["upstreamConfig", "\\u914d\\u7f6e\\u7b2c\\u4e09\\u65b9 API"\]/);
  assert.match(inject, /async function showUpstreamConfig/);
  assert.doesNotMatch(inject, /\uFFFD/);
  assert.match(inject, /showUpstreamConfig/);
  assert.match(inject, /\/anticodex\/upstream-test/);
  assert.match(inject, /\/anticodex\/upstream-apply/);
  assert.match(inject, /\/anticodex\/upstream-test/);
  assert.match(inject, /managerPostJson\("\/anticodex\/upstream-test"[\s\S]*?UPSTREAM_TEST_TIMEOUT_MS/);
  assert.match(inject, /function managerPostJson[\s\S]*?x-anticodex-manager-token/);
  assert.match(inject, /\/anticodex\/upstream-profile/);
  assert.match(inject, /\/anticodex\/upstream-apply/);
  assert.match(inject, /applyAndWait/);
  assert.match(inject, /invalidateConnectionTest/);
  assert.match(inject, /lastStages = \[\]/);
  assert.match(inject, /field\.addEventListener\("input", invalidateConnectionTest\)/);
  assert.match(inject, /UPSTREAM_TEST_TIMEOUT_MS\s*=\s*60000/);
  assert.match(inject, /retryCandidates:\s*false/);
  assert.match(inject, /allowSnapshotFallback/);
  assert.match(inject, /if \(allowSnapshotFallback && snapshotFallback\)/);
  assert.match(inject, /function upstreamConfigFingerprint/);
  assert.match(inject, /testedFingerprint/);
  assert.match(inject, /setUpstreamConfigBusy/);
  assert.match(inject, /upstreamConfigOperationInFlight/);
  assert.match(inject, /showUpstreamConfig/);
  assert.match(inject, /safeJson\("\/anticodex\/upstream-profile"\)/);
  assert.match(inject, /antigravityCliProfileRoot/);
  assert.match(inject, /antigravityCliStrict/);
  assert.match(inject, /saveAntigravityCliButton/);
  assert.match(inject, /保存 Antigravity CLI 隔离/);
  assert.match(inject, /strictWindowsAppDataIsolation/);
  assert.match(inject, /upstreamCapabilitySummary/);
  assert.match(inject, /upstreamConnectionSummaryText/);
  assert.match(inject, /summary\.suggestedAction/);
  assert.match(inject, /\\u80fd\\u529b\\u8bc1\\u636e/);
  assert.match(inject, /Antigravity/);
  assert.match(inject, /\p{Script=Han}/u);

  assert.match(server, /UPSTREAM_PROTOCOL/);
  assert.match(server, /upstreamProfile: currentUpstreamHealthProfile\(\)/);
  assert.match(server, /capabilitySummary: summarizeConnectionStages/);
  assert.match(server, /buildUpstreamChatRequest/);
  assert.match(server, /convertUpstreamChatResponse/);
  assert.match(server, /testUpstreamConnection/);
  assert.match(server, /function upstreamConnectionSummary/);
  assert.match(server, /summary:\s*upstreamConnectionSummary/);
  assert.match(server, /quota_or_billing/);
  assert.match(server, /model_not_found/);
  assert.match(server, /url\.pathname === "\/anticodex\/upstream-test"/);
  assert.match(server, /url\.pathname === "\/anticodex\/upstream-test"[\s\S]*?validateManagerActionRequest\(req\)/);
  assert.match(server, /url\.pathname === "\/anticodex\/upstream-profile"/);
  assert.match(server, /antigravityCliIsolation/);
  assert.match(server, /SaveAntigravity/);
  assert.match(server, /AntigravityCliStrictWindowsAppDataIsolation/);
  assert.match(server, /Array\.isArray\(stage\?\.models\)[\s\S]*?models:\s*stage\.models\.map/);
  assert.match(server, /providerModels:\s*providerModelIdsFromConnectionStages\(stages,\s*body\.model\)/);
  assert.match(server, /url\.pathname === "\/anticodex\/upstream-apply"/);
  assert.match(server, /apply-anticodex-upstream\.ps1/);
  assert.match(server, /ANTICODEX_UPSTREAM_API_KEY_INPUT/);

  assert.match(profile, /ProtectedData\]::Protect/);
  assert.match(profile, /SaveAntigravity/);
  assert.match(profile, /antigravityCli/);
  assert.match(profile, /strictWindowsAppDataIsolation/);
  assert.match(profile, /DataProtectionScope\]::CurrentUser/);
  assert.match(profile, /WriteAllText\(\$ProfilePath/);
  assert.doesNotMatch(profile, /apiKey\s*=\s*\$ApiKey/);

  const apply = readFileSync(resolve(root, "scripts", "apply-anticodex-upstream.ps1"), "utf8");
  assert.match(apply, /start-deepcodex\.ps1/);
  assert.match(apply, /-TranslatorOnly/);
  assert.match(apply, /WindowStyle\s*=\s*"Hidden"/);
  assert.doesNotMatch(apply, /Stop-Process|Codex\.exe|Anti-Codex\.exe/);
});

test("third-party provider verifier preserves history across save and restart", () => {
  const verifier = readFileSync(resolve(root, "scripts", "test-anticodex-third-party-provider.mjs"), "utf8");

  assert.match(verifier, /reportName,\s*\n\s*ok:/);
  assert.match(verifier, /turn-5 user asks epsilon after provider save/);
  assert.match(verifier, /fifthAfterSavePreservesHistory/);
  assert.match(verifier, /fifthOpenAiToolEvidence/);
  assert.match(verifier, /turn-tool-call user asks provider tool marker/);
  assert.match(verifier, /provider_tool_marker/);
  assert.match(verifier, /call_provider_a_tool_history/);
  assert.match(verifier, /function_call_output/);
  assert.match(verifier, /TOOL_HISTORY_MARKER_FROM_PROVIDER_A/);
  assert.match(verifier, /TOOL_HISTORY_RESULT_FROM_PROVIDER_A/);
  assert.match(verifier, /assertOpenAiToolHistory/);
  assert.match(verifier, /assertAnthropicToolHistory/);
  assert.match(verifier, /assertAllHistoryMarkers/);
  assert.match(verifier, /toolHistoryTurns: 2/);
  assert.match(verifier, /providerSwitchPreservesOpenAiToolPair/);
  assert.match(verifier, /protocolSwitchPreservesAnthropicToolPair/);
  assert.match(verifier, /reverseProtocolSwitchPreservesOpenAiToolPair/);
  assert.match(verifier, /OpenAI-compatible tool result appears before its assistant\.tool_calls entry/);
  assert.match(verifier, /Anthropic tool_result appears before its tool_use entry/);
  assert.match(verifier, /protocolShapeClean/);
  assert.match(verifier, /structuralEvidence/);
  assert.match(verifier, /function assertOrderedRoleMarkers/);
  assert.match(verifier, /sixthOrderedHistory/);
  assert.match(verifier, /seventhOrderedHistory/);
  assert.match(verifier, /eighthOrderedHistory/);
  assert.match(verifier, /ninthOrderedHistory/);
  assert.match(verifier, /await stopTranslator\(\)/);
  assert.match(verifier, /turn-6 user asks zeta after provider restart/);
  assert.match(verifier, /restartedProviderWithoutHistoryLoss/);
  assert.match(verifier, /restartContinuationPreviousResponseId/);
  assert.match(verifier, /sixthOpenAiToolEvidence/);
  assert.match(verifier, /restartPreservesOpenAiToolPair/);
  assert.match(verifier, /sixthAfterRestartPreservesHistory/);
  assert.match(verifier, /sixthAfterRestartPreservesAllHistoryMarkers/);
  assert.match(verifier, /sixthAfterRestartAllHistoryMarkerCount/);
  assert.match(verifier, /turn-7 user asks eta after provider switch/);
  assert.match(verifier, /switchedProviderWithoutHistoryLoss/);
  assert.match(verifier, /providerSwitchContinuationPreviousResponseId/);
  assert.match(verifier, /seventhAfterProviderSwitchPreservesHistory/);
  assert.match(verifier, /seventhAfterProviderSwitchPreservesAllHistoryMarkers/);
  assert.match(verifier, /fake-gpt-4\.2/);
  assert.match(verifier, /turn-8 user asks theta after protocol switch/);
  assert.match(verifier, /protocolSwitchContinuationPreviousResponseId/);
  assert.match(verifier, /eighthAfterProtocolSwitchPreservesHistory/);
  assert.match(verifier, /eighthAfterProtocolSwitchPreservesAllHistoryMarkers/);
  assert.match(verifier, /crossProtocolWithoutHistoryLoss/);
  assert.match(verifier, /fake-claude-4\.1/);
  assert.match(verifier, /openai-compatible",\s*to: "anthropic"/);
  assert.match(verifier, /turn-9 user asks iota after reverse protocol switch/);
  assert.match(verifier, /reverseProtocolSwitchContinuationPreviousResponseId/);
  assert.match(verifier, /previousResponseContinuity/);
  assert.match(verifier, /saveMatched/);
  assert.match(verifier, /restartMatched/);
  assert.match(verifier, /providerSwitchMatched/);
  assert.match(verifier, /protocolSwitchMatched/);
  assert.match(verifier, /reverseProtocolSwitchMatched/);
  assert.match(verifier, /ninthAfterReverseProtocolSwitchPreservesHistory/);
  assert.match(verifier, /ninthAfterReverseProtocolSwitchPreservesAllHistoryMarkers/);
  assert.match(verifier, /reverseCrossProtocolWithoutHistoryLoss/);
  assert.match(verifier, /fake-gpt-4\.3/);
  assert.match(verifier, /anthropic",\s*to: "openai-compatible"/);
  assert.match(verifier, /providerModelUsedForEveryTurn/);
  assert.match(verifier, /gemini-pro-agent\|gemini-3\\\.5-flash-low\|gemini-3-flash-agent/);
  assert.match(verifier, /sk-fake-secret\|sk-save-secret\|sk-second-secret\|sk-anthropic-secret\|sk-openai-return-secret/);
  assert.match(verifier, /third-party provider report leaked an API key/);
  assert.match(verifier, /responseHistoryBeforeAuthFailure/);
  assert.match(verifier, /assert\.equal\(readFileSync\(responseHistoryPath, "utf8"\), responseHistoryBeforeAuthFailure\)/);
});

test("release gates require structured provider save and restart continuity evidence", () => {
  const releaseGates = readFileSync(resolve(root, "scripts", "test-anticodex-release-gates.mjs"), "utf8");

  assert.match(releaseGates, /third_party_provider_save_structural_tool_evidence/);
  assert.match(releaseGates, /third_party_provider_restart_structural_tool_evidence/);
  assert.match(releaseGates, /third_party_provider_report_name/);
  assert.match(releaseGates, /third_party_provider_save_previous_response_id_missing/);
  assert.match(releaseGates, /third_party_provider_restart_previous_response_id_missing/);
  assert.match(releaseGates, /third_party_provider_switch_nested_previous_response_id_missing/);
  assert.match(releaseGates, /third_party_provider_protocol_nested_previous_response_id_missing/);
  assert.match(releaseGates, /third_party_provider_reverse_protocol_nested_previous_response_id_missing/);
  assert.match(releaseGates, /third_party_provider_save_previous_response_id_mismatch/);
  assert.match(releaseGates, /third_party_provider_restart_previous_response_id_mismatch/);
  assert.match(releaseGates, /third_party_provider_switch_previous_response_id_mismatch/);
  assert.match(releaseGates, /third_party_provider_protocol_previous_response_id_mismatch/);
  assert.match(releaseGates, /third_party_provider_reverse_protocol_previous_response_id_mismatch/);
  assert.match(releaseGates, /third_party_provider_save_marker_coverage/);
  assert.match(releaseGates, /third_party_provider_restart_marker_coverage/);
  assert.match(releaseGates, /third_party_provider_turn6_ordered_history/);
  assert.match(releaseGates, /third_party_provider_turn6_marker_coverage/);
  assert.match(releaseGates, /restartPreservesOpenAiToolPair/);
  assert.match(releaseGates, /fifthOpenAiToolEvidence/);
  assert.match(releaseGates, /sixthOpenAiToolEvidence/);
});

test("real third-party provider verifier is explicit isolated and secret-safe", () => {
  const verifier = readFileSync(resolve(root, "scripts", "test-anticodex-real-third-party-provider.mjs"), "utf8");

  assert.match(verifier, /--allow-real-traffic/);
  assert.match(verifier, /--allow-real-antigravity-return/);
  assert.match(verifier, /--antigravity-model/);
  assert.match(verifier, /--api-key-env/);
  assert.match(verifier, /process\.env\.APPDATA[\s\S]*?anticodex[\s\S]*?reports/);
  assert.match(verifier, /command-line API keys are not accepted/);
  assert.doesNotMatch(verifier, /args\.get\("--api-key"\)/);
  assert.doesNotMatch(verifier, /dotenv|readFileSync\([^)]*["'`]\.env/);
  assert.match(verifier, /parsedUrl\.search \|\| parsedUrl\.hash/);
  assert.match(verifier, /mkdtempSync/);
  assert.match(verifier, /DEEPCODEX_STATE_ROOT:\s*stateRoot/);
  assert.match(verifier, /CODEX_HOME_DIR:\s*join\(stateRoot/);
  assert.match(verifier, /TRANSLATOR_PROFILE_PATH:\s*profilePath/);
  assert.match(verifier, /previous_response_id:\s*first\.id/);
  assert.match(verifier, /previous_response_id:\s*second\.id/);
  assert.match(verifier, /startTranslator\("chat"\)/);
  assert.match(verifier, /stopTranslator\(\)[\s\S]*?startTranslator\("antigravity"\)/);
  assert.match(verifier, /firstMarkerObserved/);
  assert.match(verifier, /secondMarkerObserved/);
  assert.match(verifier, /historyContinuationObserved/);
  assert.match(verifier, /\/anticodex\/model-routes/);
  assert.match(verifier, /routeEvidence/);
  assert.match(verifier, /transport,\s*"upstream-provider"/);
  assert.match(verifier, /providerProtocol,\s*protocol/);
  assert.match(verifier, /resolvedModel,\s*model/);
  assert.match(verifier, /behaviorCovered:\s*false/);
  assert.match(verifier, /requestedRealTraffic/);
  assert.match(verifier, /failures:\s*ok \? \[\] : \[reason\]/);
  assert.match(verifier, /requestedRealTraffic:\s*true,\s*ok:\s*false/);
  assert.match(verifier, /coverageKind:\s*"real-traffic"[\s\S]*?requestedRealTraffic:\s*true[\s\S]*?usedRealTraffic:\s*true/);
  assert.match(verifier, /realProviderToAntigravityReturnEvidence/);
  assert.match(verifier, /returnUpstream:\s*antigravityHealth\.upstream/);
  assert.match(verifier, /usedRealTraffic:\s*true/);
  assert.match(verifier, /secretsRedacted/);
  assert.match(verifier, /latest-real-third-party-provider\.json/);
  assert.match(verifier, /JSON\.parse\(text\)/);
  assert.match(verifier, /realTrafficAttempted/);
  assert.match(verifier, /const reportText = JSON\.stringify\(result\)[\s\S]*?if \(apiKey && reportText\.includes\(apiKey\)\)[\s\S]*?writeReport\(result\)/);
  assert.match(verifier, /skipped:\s*true/);
  assert.match(verifier, /real third-party provider verification is opt-in/);
});

test("real third-party provider verifier rejects unsafe URLs before traffic", () => {
  const reportRoot = mkdtempSync(resolve(os.tmpdir(), "anticodex-real-provider-negative-"));
  try {
    const result = spawnSync(process.execPath, [
      resolve(root, "scripts", "test-anticodex-real-third-party-provider.mjs"),
      "--allow-real-traffic",
      "--protocol", "openai-compatible",
      "--base-url", "http://evil.example/v1/responses",
      "--model", "unsafe-model",
      "--api-key-env", "ANTICODEX_TEST_REAL_PROVIDER_KEY",
      "--report-root", reportRoot,
      "--timeout-ms", "10000",
    ], {
      encoding: "utf8",
      env: {
        ...process.env,
        ANTICODEX_TEST_REAL_PROVIDER_KEY: "sk-negative-test-secret",
      },
    });
    assert.equal(result.status, 1, result.stderr || result.stdout);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.ok, false);
    assert.equal(summary.usedRealTraffic, false);
    assert.equal(summary.coverageKind, "failed");
    assert.match(summary.failures.join("\n"), /non-loopback provider URLs must use HTTPS/);
    assert.doesNotMatch(JSON.stringify(summary), /sk-negative-test-secret/);
    const latest = JSON.parse(readFileSync(resolve(reportRoot, "latest-real-third-party-provider.json"), "utf8"));
    assert.equal(latest.usedRealTraffic, false);
  } finally {
    rmSync(reportRoot, { recursive: true, force: true });
  }
});

test("provider history can opt in to one real Antigravity return turn", () => {
  const verifier = readFileSync(resolve(root, "scripts", "test-anticodex-third-party-provider.mjs"), "utf8");
  const wrapper = readFileSync(resolve(root, "scripts", "test-anticodex-provider-antigravity-return.ps1"), "utf8");

  assert.match(wrapper, /\[switch\]\$AllowRealTraffic/);
  assert.match(wrapper, /if \(-not \$AllowRealTraffic\)/);
  assert.match(wrapper, /requestedRealTraffic = \$RequestedRealTraffic/);
  assert.match(wrapper, /\$failures = if \(\$Ok\) \{ \[string\[\]\]@\(\) \} else \{ \[string\[\]\]@\(\$Reason\) \}/);
  assert.match(wrapper, /failures = @\(\$failures\)/);
  assert.match(wrapper, /Write-SkipReport "another Anti-Codex real Antigravity verification is already running" \$true \$true \$false/);
  assert.match(wrapper, /behaviorCovered\s*=\s*\$false/);
  assert.match(wrapper, /Enter-AntiCodexRealTrafficLock/);
  assert.match(wrapper, /--allow-real-antigravity-turn/);
  assert.match(wrapper, /--antigravity-model/);
  assert.match(wrapper, /--report-name/);
  assert.match(wrapper, /provider-antigravity-return/);
  assert.match(verifier, /allowRealAntigravityTurn/);
  assert.match(verifier, /Invalid report name/);
  assert.match(verifier, /runtimeMode\s*=\s*"antigravity"/);
  assert.match(verifier, /await stopTranslator\(\)[\s\S]*?runtimeMode\s*=\s*"antigravity"[\s\S]*?startTranslator\(\)/);
  assert.match(verifier, /previous_response_id:\s*ninthAfterReverseProtocolSwitch\.id/);
  assert.match(verifier, /turn-10 Antigravity return/);
  assert.doesNotMatch(verifier, /turn-10 Antigravity return:[^`]*\$\{turnTenMarkers\.join/);
  assert.match(verifier, /Do not copy values from this instruction/);
  assert.match(verifier, /returnedToAntigravityWithHistory/);
  assert.match(verifier, /realAntigravityTurnUsed/);
  assert.match(verifier, /coverageKind:\s*allowRealAntigravityTurn \? "real-traffic" : "local-fake-provider"/);
  assert.match(verifier, /usedRealTraffic:\s*realAntigravityEvidence\.realAntigravityTurnUsed/);
  assert.match(verifier, /healthAfterAntigravityReturn\.upstream,\s*"antigravity-desktop"/);
});

test("user-visible legacy DeepCodex setup and launch wording is branded as Anti-Codex", () => {
  const launcher = readFileSync(resolve(root, "scripts", "start-deepcodex.ps1"), "utf8");
  const macLauncher = readFileSync(resolve(root, "scripts", "start-deepcodex.sh"), "utf8");
  const windowsLauncher = readFileSync(resolve(root, "src", "deepcodex-launcher-win.cs"), "utf8");
  const setupUi = readFileSync(resolve(root, "scripts", "deepcodex-setup-ui.mjs"), "utf8");
  const swiftSetup = readFileSync(resolve(root, "scripts", "DeepCodexSetup.swift"), "utf8");
  const pluginUnlock = readFileSync(resolve(root, "scripts", "deepcodex-plugin-unlock-inject.js"), "utf8");
  const applyBrand = readFileSync(resolve(root, "scripts", "apply-deepcodex-brand.ps1"), "utf8");
  const legacyTranslator = readFileSync(resolve(root, "translator", "server.mjs"), "utf8");

  assert.match(launcher, /Anti-Codex is already starting or running/);
  assert.match(launcher, /MessageBox\]::Show\(\$Message, "Anti-Codex"/);
  assert.match(launcher, /before launching Anti-Codex/);
  assert.match(launcher, /Anti-Codex setup page is missing/);
  assert.match(launcher, /Launching Anti-Codex/);
  assert.match(launcher, /Anti-Codex launched successfully/);
  assert.match(launcher, /Anti-Codex main window closed/);
  assert.match(launcher, /Anti-Codex main window did not appear/);
  assert.match(launcher, /Anti-Codex started but no window appeared/);
  assert.match(launcher, /\*Anti-Codex Setup\*/);
  assert.doesNotMatch(launcher, /DeepCodex is already starting or running/);
  assert.doesNotMatch(launcher, /MessageBox\]::Show\(\$Message, "deepcodex"/);
  assert.doesNotMatch(launcher, /before launching deepcodex/);
  assert.doesNotMatch(launcher, /DeepCodex setup page is missing/);
  assert.doesNotMatch(launcher, /Launching deepcodex/);
  assert.doesNotMatch(launcher, /DeepCodex launched successfully/);
  assert.doesNotMatch(launcher, /DeepCodex main window closed/);
  assert.doesNotMatch(launcher, /DeepCodex main window did not appear/);
  assert.doesNotMatch(launcher, /DeepCodex started but no window appeared/);

  assert.match(windowsLauncher, /MessageBox\.Show\([^;]*"Anti-Codex"[^;]*MessageBoxIcon\.Error\)/s);
  assert.doesNotMatch(windowsLauncher, /MessageBox\.Show\([^;]*"DeepCodex"[^;]*MessageBoxIcon\.Error\)/s);

  assert.match(macLauncher, /display alert "Anti-Codex"/);
  assert.match(macLauncher, /Launching Anti-Codex through adaptive translator/);
  assert.match(macLauncher, /Anti-Codex requires Node\.js with zstd support/);
  assert.doesNotMatch(macLauncher, /display alert "deepcodex"|Launching deepcodex through adaptive translator|DeepCodex requires Node\.js|DeepCodex setup page is missing|launching deepcodex/);

  assert.match(pluginUnlock, /Anti-Codex plugin UI unlock active/);
  assert.match(pluginUnlock, /\[Anti-Codex\] plugin unlock injection failed/);
  assert.doesNotMatch(pluginUnlock, /DeepCodex plugin UI unlock active|\[DeepCodex\] plugin unlock injection failed/);

  assert.match(applyBrand, /Anti-Codex brand patch applied/);
  assert.match(applyBrand, /Close Anti-Codex first/);
  assert.doesNotMatch(applyBrand, /DeepCodex brand patch applied|Close DeepCodex first/);

  assert.match(legacyTranslator, /Anti-Codex local search workflow/);
  assert.match(legacyTranslator, /Anti-Codex production/);
  assert.doesNotMatch(legacyTranslator, /DeepCodex local search workflow|DeepCodex production/);

  assert.match(setupUi, /<title>Anti-Codex Setup<\/title>/);
  assert.match(setupUi, /<h1>Anti-Codex<\/h1>/);
  assert.match(setupUi, /Starting Anti-Codex/);
  assert.match(setupUi, /Anti-Codex will use text mode/);
  assert.doesNotMatch(setupUi, /<title>DeepCodex Setup<\/title>|<h1>DeepCodex<\/h1>|Starting DeepCodex|DeepCodex will use text mode/);

  assert.match(swiftSetup, /Quit Anti-Codex/);
  assert.match(swiftSetup, /window\.title = "Anti-Codex"/);
  assert.match(swiftSetup, /labelWithString: "Anti-Codex"/);
  assert.match(swiftSetup, /Starting Anti-Codex/);
  assert.match(swiftSetup, /Anti-Codex will use text mode/);
  assert.doesNotMatch(swiftSetup, /Quit DeepCodex|window\.title = "DeepCodex"|labelWithString: "DeepCodex"|Starting DeepCodex|DeepCodex will use text mode/);
});

test("Windows documentation describes Anti-Codex install paths and treats legacy names as compatibility only", () => {
  const docs = readFileSync(resolve(root, "docs", "WINDOWS.md"), "utf8");

  assert.match(docs, /^# Anti-Codex Windows/m);
  assert.match(docs, /%LOCALAPPDATA%\\Anti-Codex\\runtime/);
  assert.match(docs, /%APPDATA%\\anticodex/);
  assert.match(docs, /Anti-Codex\.lnk/);
  assert.match(docs, /legacy compatibility/);
  assert.match(docs, /start-deepcodex\.ps1/);
  assert.doesNotMatch(docs, /^# DeepCodex Windows/m);
  assert.doesNotMatch(docs, /%LOCALAPPDATA%\\deepcodex\\runtime/);
  assert.doesNotMatch(docs, /DeepCodex\.lnk/);
  assert.doesNotMatch(docs, /DeepCodex for Windows is/);
});

test("current user-facing docs describe the Anti-Codex provider and connector boundaries", () => {
  const readme = readFileSync(resolve(root, "README.md"), "utf8");
  const readmeEn = readFileSync(resolve(root, "README_EN.md"), "utf8");
  const providerStack = readFileSync(resolve(root, "docs", "ADAPTIVE_ONE_API_STACK.md"), "utf8");
  const compatibility = readFileSync(resolve(root, "docs", "chat-to-responses-compat.md"), "utf8");
  const legacyMarketing = readFileSync(resolve(root, "docs", "marketing", "legacy", "deepcodex-video-script.md"), "utf8");
  const marketingDocs = [
    readFileSync(resolve(root, "docs", "marketing", "launch-post.md"), "utf8"),
    readFileSync(resolve(root, "docs", "marketing", "video-script.md"), "utf8"),
    readFileSync(resolve(root, "docs", "marketing", "wechat-article.md"), "utf8"),
  ].join("\n\n");

  assert.match(providerStack, /^# Anti-Codex provider stack/m);
  assert.match(providerStack, /Antigravity entitlement supplies model text/);
  assert.match(providerStack, /optional third-party provider profile/);
  assert.match(providerStack, /Metadata parity does not grant connector authorization/);
  assert.match(providerStack, /no ChatGPT login path/);
  assert.doesNotMatch(providerStack, /# deepcodex adaptive one-api|deepcodex\.app|setup-one-api-minimal|start-adaptive-oneapi|creates or updates a `deepcodex`/);

  assert.match(readme, /^# Anti-Codex/m);
  assert.match(readme, /Antigravity 权益/);
  assert.match(readme, /ChatGPT/);
  assert.match(readme, /DeepSeek API Key/);
  assert.match(readme, /Anti-Codex\.exe/);
  assert.match(readme, /upstream profile/);
  assert.match(readme, /connector-backed app tools/);
  assert.doesNotMatch(readme, /DeepCodex app|DeepSeek \u7248 Codex|DeepCodex launched successfully|DeepCodex for Windows is|DeepCodex\.lnk/);

  assert.match(readmeEn, /^# Anti-Codex/m);
  assert.match(readmeEn, /Antigravity entitlement/);
  assert.match(readmeEn, /ChatGPT/);
  assert.match(readmeEn, /DeepSeek API key/);
  assert.match(readmeEn, /upstream profile/);
  assert.match(readmeEn, /Connector-backed app tools/);
  assert.match(readmeEn, /must not fake callable app tools/);
  assert.doesNotMatch(readmeEn, /DeepCodex app|DeepCodex launched successfully|DeepCodex for Windows is|DeepCodex\.lnk/);

  assert.match(compatibility, /Scope: Anti-Codex translates Codex Desktop/);
  assert.match(compatibility, /Antigravity entitlement supplies model text/);
  assert.match(compatibility, /OpenAI-compatible third-party providers/);
  assert.match(compatibility, /Anthropic-compatible third-party providers/);
  assert.match(compatibility, /Connector\/app-tool metadata parity must not be treated as authorization/);
  assert.match(compatibility, /deepcodex\.reasoning\.hex\.v1:<hex>/);
  assert.match(compatibility, /internal compatibility token/);
  assert.doesNotMatch(compatibility, /Scope: deepcodex|DeepSeek route|DeepSeek-specific|Current Deepcodex Gaps|Deepcodex should/);

  assert.match(marketingDocs, /Anti-Codex/);
  assert.match(marketingDocs, /Antigravity Desktop|Antigravity/);
  assert.match(marketingDocs, /third-party|provider/);
  assert.match(marketingDocs, /connector|app tool/);
  assert.match(marketingDocs, /does not fake authorization/);
  assert.doesNotMatch(marketingDocs, /DeepCodex|deepcodex|DeepSeek-only|DeepSeek route|DeepSeek API key/);
  assert.match(legacyMarketing, /archived historical DeepCodex \/ DeepSeek launch material/);
  assert.match(legacyMarketing, /not a current Anti-Codex launch asset/);
  for (const currentDoc of [readme, readmeEn, providerStack, compatibility, marketingDocs]) {
    assert.doesNotMatch(currentDoc, /Antigravity Desktop (?:provider|is the default upstream|remains the default route|as the default)/);
    assert.doesNotMatch(currentDoc, /default route remains the local signed-in Antigravity Desktop account/);
    assert.doesNotMatch(currentDoc, /默认路线仍是本机已登录的 Antigravity Desktop/);
    assert.doesNotMatch(currentDoc, /原生 MCP 同一会话续接|native same-cascade MCP continuation/);
  }
});

test("Anti-Codex source preflight executes upstream profile assertions as part of its contract", () => {
  const preflight = readFileSync(resolve(root, "scripts", "test-anticodex-source-preflight.ps1"), "utf8");
  const profileTest = readFileSync(resolve(root, "scripts", "test-anticodex-upstream-profile.ps1"), "utf8");
  const runtimeSync = readFileSync(resolve(root, "scripts", "sync-anticodex-runtime.ps1"), "utf8");
  const installer = readFileSync(resolve(root, "scripts", "install-deepcodex.ps1"), "utf8");
  const localConnectors = readFileSync(resolve(root, "scripts", "test-anticodex-local-connectors.mjs"), "utf8");
  const antigravityCliIsolation = readFileSync(resolve(root, "scripts", "test-anticodex-antigravity-cli-isolation.ps1"), "utf8");
  const antigravityCliDualLanes = readFileSync(resolve(root, "scripts", "test-anticodex-antigravity-cli-dual-account-lanes.ps1"), "utf8");
  const antigravityCliPrepare = readFileSync(resolve(root, "scripts", "prepare-anticodex-antigravity-cli-profile.ps1"), "utf8");
  const antigravityCliRealSmoke = readFileSync(resolve(root, "scripts", "test-anticodex-antigravity-cli-real-smoke.ps1"), "utf8");
  const secondAccountPostLoginProof = readFileSync(resolve(root, "scripts", "test-anticodex-second-account-post-login-proof.ps1"), "utf8");
  const releaseGates = readFileSync(resolve(root, "scripts", "test-anticodex-release-gates.mjs"), "utf8");

  assert.match(preflight, /test-anticodex-upstream-profile\.ps1/);
  assert.match(preflight, /checks\["upstreamProfileStorage"\]/);
  assert.match(preflight, /test-anticodex-antigravity-cli-isolation\.ps1/);
  assert.match(preflight, /checks\["antigravityCliIsolationProfile"\]/);
  assert.match(preflight, /test-anticodex-antigravity-cli-dual-account-lanes\.ps1/);
  assert.match(preflight, /checks\["antigravityCliDualAccountLanes"\]/);
  assert.match(preflight, /Antigravity CLI dual account lanes contract not satisfied/);
  assert.match(preflight, /latest-antigravity-cli-dual-account-lanes\.json/);
  assert.match(preflight, /Antigravity CLI isolation profile contract not satisfied/);
  assert.match(preflight, /contract = \$isolationContract/);
  assert.match(antigravityCliIsolation, /usedRealTraffic\s*=\s*\$false/);
  assert.match(antigravityCliIsolation, /loginVerified\s*=\s*\$false/);
  assert.match(antigravityCliIsolation, /separateAccountVerified\s*=\s*\$false/);
  assert.match(antigravityCliIsolation, /accountLaneRole\s*=\s*"anticodex-model-text"/);
  assert.match(antigravityCliIsolation, /mcpAccountLaneManagedByAntiCodex\s*=\s*\$false/);
  assert.match(antigravityCliIsolation, /mcpAccountLaneOwner\s*=\s*"external-antigravity-account-not-managed-here"/);
  assert.match(antigravityCliIsolation, /profile-and-appdata-only/);
  assert.match(antigravityCliIsolation, /does not prove a separate Antigravity account/);
  assert.match(antigravityCliIsolation, /does not launch Antigravity CLI or claim account authorization/);
  assert.match(antigravityCliDualLanes, /reportName = "antigravity-cli-dual-account-lanes"/);
  assert.match(antigravityCliDualLanes, /usedRealTraffic = \$false/);
  assert.match(antigravityCliDualLanes, /loginVerified = \$false/);
  assert.match(antigravityCliDualLanes, /separateAccountVerified = \$false/);
  assert.match(antigravityCliDualLanes, /dual-antigravity-cli-account-lanes/);
  assert.match(antigravityCliDualLanes, /anticodex-model-text/);
  assert.match(antigravityCliDualLanes, /external-mcp-antigravity-account/);
  assert.match(antigravityCliDualLanes, /managedByAntiCodex = \$ManagedByAntiCodex/);
  assert.match(antigravityCliDualLanes, /profileRootsDifferent/);
  assert.match(antigravityCliDualLanes, /profileRootsNested/);
  assert.match(antigravityCliDualLanes, /appDataDifferent/);
  assert.match(antigravityCliDualLanes, /localAppDataDifferent/);
  assert.match(antigravityCliDualLanes, /geminiDirDifferent/);
  assert.match(antigravityCliDualLanes, /neitherUsesDefaultAntigravityProfile/);
  assert.match(antigravityCliDualLanes, /does not prove login, account identity, or Windows credential-store separation/);
  assert.match(releaseGates, /source_preflight_antigravity_cli_dual_account_lanes/);
  assert.match(releaseGates, /source_preflight_dual_account_lanes_contract_missing/);
  assert.match(releaseGates, /source_preflight_dual_lanes_profile_roots_not_different/);
  assert.match(releaseGates, /source_preflight_dual_lanes_mcp_managed_by_anticodex/);
  assert.match(antigravityCliPrepare, /reportName = "antigravity-cli-profile-prepare"/);
  assert.match(antigravityCliPrepare, /usedRealTraffic = \$false/);
  assert.match(antigravityCliPrepare, /loginVerified = \$false/);
  assert.match(antigravityCliPrepare, /separateAccountVerified = \$false/);
  assert.match(antigravityCliPrepare, /shared Windows credential store/);
  assert.match(antigravityCliPrepare, /profile-prepare-failed/);
  assert.match(antigravityCliPrepare, /Invoke-AntigravityCli-Isolated\.ps1/);
  assert.match(antigravityCliPrepare, /-StrictWindowsAppDataIsolation/);
  assert.match(antigravityCliPrepare, /Do not use Antigravity Desktop or coworker/);
  assert.match(antigravityCliRealSmoke, /\[switch\]\$AllowRealTraffic/);
  assert.match(antigravityCliRealSmoke, /real Antigravity CLI traffic is opt-in/);
  assert.match(antigravityCliRealSmoke, /refusing to use the default account/);
  assert.match(antigravityCliRealSmoke, /requestedRealTraffic/);
  assert.match(antigravityCliRealSmoke, /coverageKind = "skipped"/);
  assert.match(antigravityCliRealSmoke, /strict Windows AppData isolation is required/);
  assert.match(antigravityCliPrepare, /function Test-IsDefaultAntigravityProfilePath/);
  assert.match(antigravityCliRealSmoke, /function Test-IsDefaultAntigravityProfilePath/);
  assert.match(antigravityCliPrepare, /profileRoot matches or nests under a known default Antigravity profile location/);
  assert.match(antigravityCliRealSmoke, /profileRoot matches or nests under a known default Antigravity profile location/);
  assert.match(antigravityCliPrepare, /StartsWith\(\$defaultFull \+ \[IO\.Path\]::DirectorySeparatorChar, \[StringComparison\]::OrdinalIgnoreCase\)/);
  assert.match(antigravityCliRealSmoke, /StartsWith\(\$defaultFull \+ \[IO\.Path\]::DirectorySeparatorChar, \[StringComparison\]::OrdinalIgnoreCase\)/);
  assert.match(antigravityCliRealSmoke, /runAntigravityTextTurn/);
  assert.match(antigravityCliRealSmoke, /ANTICODEX_ANTIGRAVITY_CLI_PROFILE_ROOT/);
  assert.match(antigravityCliRealSmoke, /latest-antigravity-cli-profile-prepare\.json/);
  assert.match(antigravityCliRealSmoke, /profileMatched/);
  assert.match(antigravityCliRealSmoke, /\[switch\]\$AllowSeparateAccountProof/);
  assert.match(antigravityCliRealSmoke, /\[string\]\$WindowsUser = "\.\\AntiCodexModel"/);
  assert.match(antigravityCliRealSmoke, /currentWindowsUser = \[Security\.Principal\.WindowsIdentity\]::GetCurrent\(\)\.Name/);
  assert.match(antigravityCliRealSmoke, /runningAsTargetWindowsUser/);
  assert.match(antigravityCliRealSmoke, /\[string\]\$AntiCodexAccountId/);
  assert.match(antigravityCliRealSmoke, /\[string\]\$McpAccountId/);
  assert.match(antigravityCliRealSmoke, /\[string\]\$SeparateAccountProofApprovalId/);
  assert.match(antigravityCliRealSmoke, /\[ValidateSet\("profile-and-appdata-only", "separate-windows-user", "official-independent-credential-store"\)\]/);
  assert.match(antigravityCliRealSmoke, /\[string\]\$AccountIsolationBoundary = "profile-and-appdata-only"/);
  assert.match(antigravityCliRealSmoke, /account identity inputs require -AllowSeparateAccountProof/);
  assert.match(antigravityCliRealSmoke, /explicit separate-account proof approval id is required/);
  assert.match(antigravityCliRealSmoke, /same Windows user profile\/AppData isolation is not credential isolation/);
  assert.match(antigravityCliRealSmoke, /separate-Windows-user proof must run under the target Windows user/);
  assert.match(antigravityCliRealSmoke, /Anti-Codex and MCP Antigravity account identities match/);
  assert.ok(
    antigravityCliRealSmoke.indexOf("separate-Windows-user proof must run under the target Windows user") <
      antigravityCliRealSmoke.indexOf("runAntigravityTextTurn"),
    "separate-account proof preconditions must run before real traffic",
  );
  assert.match(antigravityCliRealSmoke, /\$report\.accountIdentityComparison = \$accountIdentityComparison/);
  assert.match(antigravityCliRealSmoke, /antiCodexSource = "anticodex-cli-real-smoke"/);
  assert.match(antigravityCliRealSmoke, /mcpSource = "external-mcp-antigravity-account"/);
  assert.match(antigravityCliRealSmoke, /comparisonMethod = "explicit-user-approved-account-identity-parameter"/);
  assert.match(antigravityCliRealSmoke, /capturedAt = \$CapturedAt/);
  assert.match(antigravityCliRealSmoke, /approvalId = \$ApprovalId/);
  assert.match(antigravityCliRealSmoke, /approvalSource = "explicit-user-approval"/);
  assert.match(antigravityCliRealSmoke, /separateAccountVerified = \$false/);
  assert.match(antigravityCliRealSmoke, /Windows credential-store/);
  assert.match(secondAccountPostLoginProof, /reportName = "second-account-post-login-proof"/);
  assert.match(secondAccountPostLoginProof, /test-anticodex-antigravity-account-isolation-status\.ps1/);
  assert.match(secondAccountPostLoginProof, /test-anticodex-antigravity-cli-real-smoke\.ps1/);
  assert.match(secondAccountPostLoginProof, /\[switch\]\$ConfirmInteractiveLoginComplete/);
  assert.match(secondAccountPostLoginProof, /interactive_login_confirmation_required/);
  assert.match(secondAccountPostLoginProof, /proofCommandPreview/);
  assert.match(secondAccountPostLoginProof, /<provided-anticodex-account-id>/);
  assert.match(secondAccountPostLoginProof, /<provided-mcp-account-id>/);
  assert.match(secondAccountPostLoginProof, /second-account-post-login-proof-dry-run/);
  assert.match(secondAccountPostLoginProof, /second-account-post-login-proof-real-traffic/);
  assert.match(secondAccountPostLoginProof, /releaseAcceptableAccountProof/);
  assert.match(secondAccountPostLoginProof, /Dry-run only\. This does not start login, use real traffic, capture passwords, or prove distinct Antigravity account identity\./);
  assert.match(preflight, /checks\["logDbGuardSelfTest"\]/);
  assert.match(preflight, /function Test-AntigravityCliProfilePrepare/);
  assert.match(preflight, /checks\["antigravityCliProfilePrepare"\] = Test-AntigravityCliProfilePrepare/);
  assert.match(preflight, /function Test-AntigravityCliProfilePrepareRejectsDefaultChild/);
  assert.match(preflight, /checks\["antigravityCliProfilePrepareRejectsDefaultChild"\] = Test-AntigravityCliProfilePrepareRejectsDefaultChild/);
  assert.match(preflight, /function Test-AntigravityCliWindowsUserLoginDryRun/);
  assert.match(preflight, /checks\["antigravityCliWindowsUserLoginDryRun"\] = Test-AntigravityCliWindowsUserLoginDryRun/);
  assert.match(preflight, /start-anticodex-antigravity-cli-login-windows-user\.ps1/);
  assert.match(preflight, /credentialBoundary -eq "separate-windows-user"/);
  assert.match(preflight, /expectedCredentialStoreIsolation -eq \$true/);
  assert.match(preflight, /capturesLoginOutput -eq \$false/);
  assert.match(preflight, /started -eq \$false/);
  assert.match(preflight, /readinessChecked -eq \$true/);
  assert.match(preflight, /targetUserIsCurrentUser -eq \$false/);
  assert.match(preflight, /readinessBlockingReason/);
  assert.match(preflight, /Antigravity\\anticodex-srcpreflight-bad-child-/);
  assert.match(preflight, /known default Antigravity profile location/);
  assert.match(preflight, /usedRealTraffic -eq \$false/);
  assert.match(preflight, /-NoSaveProfile/);
  assert.match(preflight, /anticodex-srcpreflight-state-/);
  assert.match(preflight, /anticodex-srcpreflight-report-/);
  assert.match(preflight, /anticodex-srcpreflight-profile-/);
  assert.match(preflight, /usedRealTraffic.*\$false/);
  assert.match(preflight, /loginVerified.*\$false/);
  assert.match(preflight, /separateAccountVerified.*\$false/);
  assert.match(preflight, /profile-prepared-no-traffic/);
  assert.match(preflight, /antigravityCliProfilePrepareOk/);
  assert.match(preflight, /antigravityCliWindowsUserLoginDryRunOk/);
  assert.match(releaseGates, /source_preflight_cli_isolation_account_lane_role/);
  assert.match(releaseGates, /source_preflight_cli_isolation_mcp_lane_managed_by_anticodex/);
  assert.match(releaseGates, /source_preflight_cli_isolation_mcp_lane_owner_mismatch/);
  assert.match(releaseGates, /source_preflight_cli_isolation_caveat_missing/);
  assert.match(runtimeSync, /Copy-AntiCodexPublicDocs/);
  assert.match(runtimeSync, /README_EN\.md/);
  assert.match(runtimeSync, /docs\\ADAPTIVE_ONE_API_STACK\.md/);
  assert.match(runtimeSync, /docs\\WINDOWS\.md/);
  assert.match(runtimeSync, /docs\\DEEPSEEK_RUNTIME_FAILURE_NOTES\.md/);
  assert.match(installer, /Copy-DeepCodexPublicDocs/);
  assert.match(localConnectors, /CODEX_HOME: codexHome/);

  assert.match(profileTest, /unreadable existing third-party key must fail closed/);
  assert.match(profileTest, /corrupt third-party key can still restore Antigravity/);
});

test("current docs describe Antigravity as model entitlement, not Desktop coworker default", () => {
  const handoff = readFileSync(resolve(root, "docs", "audits", "2026-06-22-handoff-next-channel.md"), "utf8");
  const readme = readFileSync(resolve(root, "README.md"), "utf8");
  const readmeEn = readFileSync(resolve(root, "README_EN.md"), "utf8");
  const videoScript = readFileSync(resolve(root, "docs", "marketing", "video-script.md"), "utf8");
  for (const source of [handoff, videoScript]) {
    assert.doesNotMatch(source, /Antigravity Desktop as the default model provider/);
    assert.doesNotMatch(source, /uses Antigravity Desktop as the default\s+provider/);
    assert.match(source, /Antigravity entitlement/);
  }
  assert.match(readme, /受保护的客户端同步/);
  assert.match(readme, /不是把 Codex 功能一个一个重做出来/);
  assert.match(readmeEn, /guarded client sync/);
  assert.match(readmeEn, /not a feature-by-feature reimplementation/);
  assert.match(handoff, /Antigravity coworker\/tool execution is not the default product path/);
  assert.match(videoScript, /Codex-owned tools stay in Anti-Codex/);
});

test("task plan current status distinguishes release readiness from second-account goal proof", () => {
  const taskPlan = readFileSync(resolve(root, "task_plan.md"), "utf8");
  const handoff = readFileSync(resolve(root, "docs", "audits", "2026-06-22-handoff-next-channel.md"), "utf8");
  const currentStatus = taskPlan.split("## Goal")[0];
  const handoffCurrentStatus = handoff.split("## Important Recent Checks")[0];

  assert.match(currentStatus, /shortReady:true/);
  assert.match(currentStatus, /releaseReady:true/);
  assert.match(currentStatus, /active goal still lacks separate Antigravity account proof|second Antigravity account proof still requires/);
  assert.match(currentStatus, /codexLikeProcessProof:true|Codex-like process proof/);
  assert.match(currentStatus, /UI_COMPLEX_PROJECT_SMOKE_1782942452664/);
  assert.match(currentStatus, /quota-exhausted|quota exhaustion/);
  assert.match(currentStatus, /claude-sonnet-4-6/);
  assert.match(currentStatus, /compactionResume/);
  assert.match(currentStatus, /goalComplete:false/);
  assert.match(currentStatus, /separateAccountVerified:false/);
  assert.match(currentStatus, /releaseAcceptableAccountProof:false/);
  assert.match(handoffCurrentStatus, /shortReady:true/);
  assert.match(handoffCurrentStatus, /releaseReady:true/);
  assert.match(handoffCurrentStatus, /Full active-goal completion is still blocked|active goal still needs separate Antigravity account proof/);
  assert.match(handoffCurrentStatus, /codexLikeProcessProof:true|Codex-like process proof/);
  assert.match(handoffCurrentStatus, /UI_COMPLEX_PROJECT_SMOKE_1782942452664/);
  assert.match(handoffCurrentStatus, /claude-sonnet-4-6/);
  assert.match(handoffCurrentStatus, /separateAccountVerified:false/);
  assert.match(handoffCurrentStatus, /releaseAcceptableAccountProof:false/);
});

test("current project direction keeps separate Antigravity account lanes for MCP and Anti-Codex", () => {
  const taskPlan = readFileSync(resolve(root, "task_plan.md"), "utf8");
  const findings = readFileSync(resolve(root, "findings.md"), "utf8");
  const handoff = readFileSync(resolve(root, "docs", "audits", "2026-06-22-handoff-next-channel.md"), "utf8");
  const antigravityCliPrepare = readFileSync(resolve(root, "scripts", "prepare-anticodex-antigravity-cli-profile.ps1"), "utf8");
  const antigravityCliRealSmoke = readFileSync(resolve(root, "scripts", "test-anticodex-antigravity-cli-real-smoke.ps1"), "utf8");
  const currentStatus = taskPlan.split("## Goal")[0];
  const baseline = taskPlan.split("## Phases")[0];
  const handoffCurrentStatus = handoff.split("## Important Recent Checks")[0];

  assert.match(currentStatus, /Gemini CLI is not usable/);
  assert.match(currentStatus, /separate Antigravity CLI profile\/account/);
  assert.match(currentStatus, /MCP can use a different Antigravity account/);
  assert.match(baseline, /two account\/profile boundaries/);
  assert.match(baseline, /MCP wiring is handled outside this channel/);
  assert.match(handoffCurrentStatus, /two-account\/profile split/);
  assert.match(handoffCurrentStatus, /Do not run real account\/traffic proof without explicit approval/);
  assert.match(findings, /Gemini CLI is not usable for the MCP-side account split/);
  assert.match(findings, /previous single-Antigravity-account fallback is superseded/);
  assert.match(findings, /isolated Antigravity CLI profile\/account for model text/);
  assert.match(findings, /do not claim true separate-account proof without explicit approved real account\/traffic evidence/);

  assert.match(antigravityCliPrepare, /separateAccountVerified = \$false/);
  assert.match(antigravityCliRealSmoke, /separateAccountVerified = \$false/);

  assert.doesNotMatch(currentStatus, /uses one Antigravity CLI account\/profile/);
  assert.doesNotMatch(baseline, /single-account by default/);
  assert.doesNotMatch(findings, /uses one Antigravity CLI account\/profile/);
  assert.doesNotMatch(findings, /Gemini CLI covers MCP-side account split/);
  assert.doesNotMatch(handoffCurrentStatus, /uses one Antigravity CLI account\/profile/);
});

test("current account-mode docs reject Gemini CLI fallback", () => {
  const taskPlan = readFileSync(resolve(root, "task_plan.md"), "utf8");
  const findings = readFileSync(resolve(root, "findings.md"), "utf8");
  const handoff = readFileSync(resolve(root, "docs", "audits", "2026-06-22-handoff-next-channel.md"), "utf8");
  const currentStatus = taskPlan.split("## Goal")[0];
  const baseline = taskPlan.split("## Phases")[0];
  const handoffCurrentStatus = handoff.split("## Important Recent Checks")[0];
  assert.match(currentStatus, /Gemini CLI is not usable/);
  assert.match(findings, /Gemini CLI is not usable for the MCP-side account split/);
  assert.match(handoffCurrentStatus, /two-account\/profile split/);

  assert.match(handoffCurrentStatus, /Do not run real account\/traffic proof without explicit approval/);
  assert.match(findings, /do not claim true separate-account proof without explicit approved real account\/traffic evidence/);

  assert.doesNotMatch(currentStatus, /Gemini CLI covers MCP-side account split/);
  assert.doesNotMatch(findings, /Gemini CLI covers MCP-side account split/);
  assert.doesNotMatch(handoffCurrentStatus, /Gemini CLI covers MCP-side account split/);
  assert.doesNotMatch(currentStatus, /uses one Antigravity CLI account\/profile/);
  assert.doesNotMatch(findings, /uses one Antigravity CLI account\/profile/);
  assert.doesNotMatch(handoffCurrentStatus, /uses one Antigravity CLI account\/profile/);
  assert.doesNotMatch(baseline, /single-account by default/);
});

test("current status documents optional Antigravity CLI real-smoke account-lane hardening", () => {
  const taskPlan = readFileSync(resolve(root, "task_plan.md"), "utf8");
  const handoff = readFileSync(resolve(root, "docs", "audits", "2026-06-22-handoff-next-channel.md"), "utf8");
  const currentStatus = taskPlan.split("## Goal")[0];
  const handoffCurrentStatus = handoff.split("## Important Recent Checks")[0];
  const combined = currentStatus + "\n" + handoffCurrentStatus;

  assert.match(combined, /optional Antigravity CLI real-smoke reports/i);
  assert.match(combined, /accountLaneRole/);
  assert.match(combined, /mcpAccountLaneManagedByAntiCodex/);
  assert.match(combined, /mcpAccountLaneOwner/);
  assert.match(combined, /release gate.*reject/i);
  assert.match(combined, /antigravityCliRealSmoke lane/);
  assert.match(combined, /diagnostics validate.*optional real-smoke summary/i);
});

test("Antigravity CLI account isolation scripts keep separate-account proof gated", () => {
  const antigravityCliPrepare = readFileSync(resolve(root, "scripts", "prepare-anticodex-antigravity-cli-profile.ps1"), "utf8");
  const antigravityCliRealSmoke = readFileSync(resolve(root, "scripts", "test-anticodex-antigravity-cli-real-smoke.ps1"), "utf8");
  const antigravityCliIsolation = readFileSync(resolve(root, "scripts", "test-anticodex-antigravity-cli-isolation.ps1"), "utf8");
  assert.match(antigravityCliPrepare, /separateAccountVerified = \$false/);
  assert.match(antigravityCliRealSmoke, /separateAccountVerified = \$false/);

  assert.match(antigravityCliPrepare, /shared Windows credential store/);
  assert.match(antigravityCliRealSmoke, /Windows credential-store/);

  assert.match(antigravityCliIsolation, /does not launch Antigravity CLI or claim account authorization/);

  assert.doesNotMatch(antigravityCliPrepare, /Gemini CLI covers MCP-side account split/);
  assert.doesNotMatch(antigravityCliRealSmoke, /Gemini CLI covers MCP-side account split/);
  assert.doesNotMatch(antigravityCliIsolation, /Gemini CLI covers MCP-side account split/);
  assert.doesNotMatch(antigravityCliPrepare, /uses one Antigravity CLI account\/profile/);
  assert.doesNotMatch(antigravityCliRealSmoke, /uses one Antigravity CLI account\/profile/);
});

test("Antigravity prompt preserves the model-text boundary, not coworker identity", () => {
  const upstream = readFileSync(resolve(root, "translator", "antigravity-upstream.mjs"), "utf8");

  assert.match(upstream, /guarded Codex client copy/);
  assert.match(upstream, /Codex-owned tools stay in Anti-Codex/);
  assert.match(upstream, /Antigravity supplies model text/);
  assert.doesNotMatch(upstream, /Codex-style desktop coworker powered by Antigravity/);
  assert.doesNotMatch(upstream, /powered by Antigravity/);
});

test("legacy DEEPSEEK_RUNTIME_FAILURE_NOTES has no stale Desktop default-provider wording and carries legacy/current boundary", () => {
  const notes = readFileSync(resolve(root, "docs", "DEEPSEEK_RUNTIME_FAILURE_NOTES.md"), "utf8");
  assert.doesNotMatch(notes, /defaults to the local Antigravity Desktop provider/);
  assert.match(notes, /legacy route notes/);
  assert.match(notes, /not the current Anti-Codex default provider/);
});

test("Anti-Codex ships an installed no-traffic missing-history verifier", () => {
  const verifier = readFileSync(resolve(root, "scripts", "test-anticodex-missing-history.mjs"), "utf8");
  const overall = readFileSync(resolve(root, "scripts", "test-anticodex-installed-overall.ps1"), "utf8");
  const collector = readFileSync(resolve(root, "scripts", "collect-anticodex-diagnostics.ps1"), "utf8");
  const releaseGates = readFileSync(resolve(root, "scripts", "test-anticodex-release-gates.mjs"), "utf8");
  const summarizer = readFileSync(resolve(root, "scripts", "summarize-anticodex-report.mjs"), "utf8");
  const diagnostics = readFileSync(resolve(root, "scripts", "test-anticodex-diagnostics.ps1"), "utf8");
  const inject = readFileSync(resolve(root, "scripts", "anticodex-manager-inject.js"), "utf8");
  const bridge = readFileSync(resolve(root, "scripts", "anticodex-manager-bridge.mjs"), "utf8");
  const server = readFileSync(resolve(root, "translator", "adaptive-server.mjs"), "utf8");

  assert.match(verifier, /response_history_missing/);
  assert.match(verifier, /previous_response_id/);
  assert.match(verifier, /retryable/);
  assert.match(verifier, /Start a fresh request or reopen the original conversation context/);
  assert.match(verifier, /routeBefore/);
  assert.match(verifier, /routeAfter/);
  assert.match(verifier, /noRouteChange/);
  assert.match(verifier, /latest-missing-history\.json/);
  assert.match(verifier, /createHash\("sha256"\)/);
  assert.match(verifier, /usedRealTraffic:\s*false/);
  assert.match(verifier, /gatewayReachable:\s*false/);
  assert.match(verifier, /local_gateway_offline/);
  assert.match(verifier, /gateway_endpoint_unreachable/);
  assert.match(verifier, /local gateway offline or unreachable/);
  assert.match(overall, /\$checks\.missingHistory\s*=\s*if \(\$Fast -and -not \(Test-FastBudgetAvailable "missing response history verification" 8000\)\)/);
  assert.match(overall, /Invoke-NodeJsonScript "Missing response history verification"/);
  assert.match(overall, /test-anticodex-missing-history\.mjs/);
  assert.match(overall, /latest-missing-history\.json/);
  assert.match(collector, /latest-missing-history\.json/);
  assert.match(collector, /missingHistoryEvidence = \$json\.missingHistoryEvidence/);
  assert.match(server, /latest-missing-history\.json/);
  assert.match(summarizer, /missingHistoryEvidence/);
  assert.match(diagnostics, /missing-history summary missing missingHistoryEvidence/);
  assert.match(diagnostics, /diagnostic reports summary missing latest-missing-history\.json/);
  assert.match(diagnostics, /diagnostic reports summary missing latest-third-party-provider\.json/);
  assert.match(diagnostics, /missing-history summary status is not 410/);
  assert.match(diagnostics, /missing-history summary should be non-retryable/);
  assert.match(diagnostics, /missing-history summary reports route change/);
  assert.match(bridge, /missingHistory: status=/);
  assert.match(inject, /missingHistory: status=/);
  assert.match(server, /missingHistory: status=/);
  assert.match(releaseGates, /id:\s*"missingHistory"[\s\S]*?file:\s*"latest-missing-history\.json"[\s\S]*?requiredForShort:\s*true/);
  assert.match(releaseGates, /requireMissingHistorySemantics:\s*true/);
  assert.match(releaseGates, /missing_history_status_not_410/);
  assert.match(releaseGates, /response_history_missing/);
  assert.match(releaseGates, /missing_history_used_real_traffic/);
  assert.match(releaseGates, /missing_history_route_changed/);
  assert.match(releaseGates, /local_gateway_offline/);

  const tempRoot = mkdtempSync(join(os.tmpdir(), "anticodex-missing-history-summary-"));
  try {
    const reportPath = join(tempRoot, "latest-missing-history.json");
    writeFileSync(reportPath, JSON.stringify({
      ok: true,
      reportName: "missing-history",
      behaviorCovered: true,
      coverageKind: "installed-no-traffic",
      usedRealTraffic: false,
      status: 410,
      errorType: "response_history_missing",
      retryable: false,
      previousResponseIdMatched: true,
      recoveryGuidancePresent: true,
      noRouteChange: true,
      model: "gemini-pro-agent",
      routeBefore: { latestStatus: "success" },
      routeAfter: { latestStatus: "success" },
    }), "utf8");
    const result = spawnSync(process.execPath, [resolve(root, "scripts", "summarize-anticodex-report.mjs"), reportPath], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const summary = JSON.parse(result.stdout);
    assert.deepEqual(summary.missingHistoryEvidence, {
      reportName: "missing-history",
      status: 410,
      errorType: "response_history_missing",
      retryable: false,
      previousResponseIdMatched: true,
      recoveryGuidancePresent: true,
      noRouteChange: true,
      usedRealTraffic: false,
      behaviorCovered: true,
      coverageKind: "installed-no-traffic",
      model: "gemini-pro-agent",
      routeBeforeStatus: "success",
      routeAfterStatus: "success",
    });
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("summarize-anticodex-report exposes antigravity-cli-profile-prepare isolation boundary fields", () => {
  const tempRoot = mkdtempSync(join(os.tmpdir(), "anticodex-cli-profile-prepare-summary-"));
  try {
    const reportPath = join(tempRoot, "latest-antigravity-cli-profile-prepare.json");
    writeFileSync(reportPath, JSON.stringify({
      ok: true,
      reportName: "antigravity-cli-profile-prepare",
      separateAccountVerified: false,
      accountLaneRole: "anticodex-model-text",
      mcpAccountLaneManagedByAntiCodex: false,
      mcpAccountLaneOwner: "external-antigravity-account-not-managed-here",
      accountIsolationBoundary: "profile-and-appdata-only",
      accountIsolationCaveat: "This prepares isolated CLI files and AppData paths only; if Antigravity CLI uses the shared Windows credential store, a real smoke can still use the currently signed-in Windows credential.",
    }), "utf8");
    const result = spawnSync(process.execPath, [resolve(root, "scripts", "summarize-anticodex-report.mjs"), reportPath], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.ok, true);
    assert.equal(summary.reportName, "antigravity-cli-profile-prepare");
    assert.deepEqual(summary.antigravityCliProfilePrepareEvidence, {
      reportName: "antigravity-cli-profile-prepare",
      separateAccountVerified: false,
      accountLaneRole: "anticodex-model-text",
      mcpAccountLaneManagedByAntiCodex: false,
      mcpAccountLaneOwner: "external-antigravity-account-not-managed-here",
      accountIsolationBoundary: "profile-and-appdata-only",
      accountIsolationCaveat: "This prepares isolated CLI files and AppData paths only; if Antigravity CLI uses the shared Windows credential store, a real smoke can still use the currently signed-in Windows credential.",
    });
    assert.equal(summary.antigravityCliRealSmokeEvidence, null);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("summarize-anticodex-report exposes antigravity-cli-real-smoke isolation boundary and preparationReport.profileMatched", () => {
  const tempRoot = mkdtempSync(join(os.tmpdir(), "anticodex-cli-real-smoke-summary-"));
  try {
    const reportPath = join(tempRoot, "latest-antigravity-cli-real-smoke.json");
    writeFileSync(reportPath, JSON.stringify({
      ok: true,
      reportName: "antigravity-cli-real-smoke",
      requestedRealTraffic: false,
      usedRealTraffic: false,
      coverageKind: "skipped",
      strictWindowsAppDataIsolation: true,
      profileSource: "saved-profile",
      loginVerified: true,
      loginVerifiedMethod: "marker-match",
      separateAccountVerified: false,
      accountLaneRole: "anticodex-model-text",
      mcpAccountLaneManagedByAntiCodex: false,
      mcpAccountLaneOwner: "external-antigravity-account-not-managed-here",
      separateAccountVerificationReason: "marker match proves Antigravity CLI model access for this profile path; it does not prove a different Windows credential-store account",
      accountIsolationBoundary: "profile-and-appdata-only",
      accountIsolationCaveat: "Skipped real traffic; no account identity or Windows credential-store isolation was verified.",
      preparationReport: { profileMatched: false },
    }), "utf8");
    const result = spawnSync(process.execPath, [resolve(root, "scripts", "summarize-anticodex-report.mjs"), reportPath], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.ok, true);
    assert.equal(summary.reportName, "antigravity-cli-real-smoke");
    assert.deepEqual(summary.antigravityCliRealSmokeEvidence, {
      reportName: "antigravity-cli-real-smoke",
      requestedRealTraffic: false,
      usedRealTraffic: false,
      coverageKind: "skipped",
      strictWindowsAppDataIsolation: true,
      profileSource: "saved-profile",
      loginVerified: true,
      loginVerifiedMethod: "marker-match",
      separateAccountVerified: false,
      accountLaneRole: "anticodex-model-text",
      mcpAccountLaneManagedByAntiCodex: false,
      mcpAccountLaneOwner: "external-antigravity-account-not-managed-here",
      separateAccountVerificationReason: "marker match proves Antigravity CLI model access for this profile path; it does not prove a different Windows credential-store account",
      accountIsolationBoundary: "profile-and-appdata-only",
      accountIsolationCaveat: "Skipped real traffic; no account identity or Windows credential-store isolation was verified.",
      preparationReport: { profileMatched: false },
    });
    assert.equal(summary.antigravityCliProfilePrepareEvidence, null);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("summarize-anticodex-report real-smoke evidence is null when preparationReport is missing", () => {
  const tempRoot = mkdtempSync(join(os.tmpdir(), "anticodex-cli-real-smoke-noprep-"));
  try {
    const reportPath = join(tempRoot, "latest-antigravity-cli-real-smoke.json");
    writeFileSync(reportPath, JSON.stringify({
      ok: true,
      reportName: "antigravity-cli-real-smoke",
      requestedRealTraffic: false,
      usedRealTraffic: false,
      coverageKind: "skipped",
      separateAccountVerified: false,
      accountIsolationBoundary: "profile-and-appdata-only",
      accountIsolationCaveat: "No preparationReport present.",
    }), "utf8");
    const result = spawnSync(process.execPath, [resolve(root, "scripts", "summarize-anticodex-report.mjs"), reportPath], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.antigravityCliRealSmokeEvidence.preparationReport, null);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("Antigravity CLI real-smoke skip path ignores account proof inputs without real traffic", () => {
  const tempRoot = mkdtempSync(join(os.tmpdir(), "anticodex-real-smoke-skip-identity-"));
  try {
    const result = spawnSync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      resolve(root, "scripts", "test-anticodex-antigravity-cli-real-smoke.ps1"),
      "-ReportRoot",
      tempRoot,
      "-AntiCodexAccountId",
      "anticodex-private-test-id",
      "-McpAccountId",
      "mcp-private-test-id",
      "-SeparateAccountProofApprovalId",
      "approval-private-test-id",
    ], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.doesNotMatch(result.stdout, /anticodex-private-test-id|mcp-private-test-id|approval-private-test-id/);
    const report = JSON.parse(result.stdout.trim());
    assert.equal(report.usedRealTraffic, false);
    assert.equal(report.separateAccountVerified, false);
    assert.equal(Object.prototype.hasOwnProperty.call(report, "accountIdentityComparison"), false);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("Antigravity CLI real-smoke rejects wrong Windows user before real traffic", () => {
  const tempRoot = mkdtempSync(join(os.tmpdir(), "anticodex-real-smoke-preflight-"));
  try {
    const result = spawnSync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      resolve(root, "scripts", "test-anticodex-antigravity-cli-real-smoke.ps1"),
      "-AllowRealTraffic",
      "-ReportRoot",
      tempRoot,
      "-ProfileRoot",
      join(tempRoot, "profile"),
      "-StrictWindowsAppDataIsolation",
      "-AccountIsolationBoundary",
      "separate-windows-user",
      "-WindowsUser",
      ".\\AntiCodexModel",
      "-AllowSeparateAccountProof",
      "-AntiCodexAccountId",
      "anticodex-private-test-id",
      "-McpAccountId",
      "mcp-private-test-id",
      "-SeparateAccountProofApprovalId",
      "approval-private-test-id",
    ], { encoding: "utf8" });
    assert.equal(result.status, 1, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout.trim());
    assert.equal(report.requestedRealTraffic, true);
    assert.equal(report.usedRealTraffic, false);
    assert.equal(report.separateAccountVerified, false);
    assert.ok(report.failures.includes("separate-Windows-user proof must run under the target Windows user before account proof can be recorded"));
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("second account post-login proof dry-run resolves command without leaking account ids", () => {
  const tempRoot = mkdtempSync(join(os.tmpdir(), "anticodex-post-login-proof-"));
  try {
    const result = spawnSync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      resolve(root, "scripts", "test-anticodex-second-account-post-login-proof.ps1"),
      "-ReportRoot",
      tempRoot,
      "-AntiCodexAccountId",
      "anticodex-private-test-id",
      "-McpAccountId",
      "mcp-private-test-id",
      "-SeparateAccountProofApprovalId",
      "approval-private-test-id",
    ], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.doesNotMatch(result.stdout, /anticodex-private-test-id|mcp-private-test-id|approval-private-test-id/);
    const report = JSON.parse(result.stdout.trim());
    assert.equal(report.reportName, "second-account-post-login-proof");
    assert.equal(report.noTraffic, true);
    assert.equal(report.requestedRealTraffic, false);
    assert.equal(report.usedRealTraffic, false);
    assert.equal(report.releaseAcceptableAccountProof, false);
    assert.equal(report.proofInputs.antiCodexAccountIdPresent, true);
    assert.equal(report.proofInputs.mcpAccountIdPresent, true);
    assert.equal(report.proofInputs.separateAccountProofApprovalIdPresent, true);
    assert.match(report.proofCommandPreview, /<provided-anticodex-account-id>/);
    assert.match(report.proofCommandPreview, /<provided-mcp-account-id>/);
    assert.match(report.proofCommandPreview, /<provided-explicit-user-approval-id>/);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("summarize-anticodex-report real-smoke retains caveat and does not claim verification when separateAccountVerified=false", () => {
  const tempRoot = mkdtempSync(join(os.tmpdir(), "anticodex-cli-real-smoke-false-caveat-"));
  try {
    const reportPath = join(tempRoot, "latest-antigravity-cli-real-smoke.json");
    writeFileSync(reportPath, JSON.stringify({
      ok: true,
      reportName: "antigravity-cli-real-smoke",
      requestedRealTraffic: false,
      usedRealTraffic: false,
      coverageKind: "skipped",
      strictWindowsAppDataIsolation: true,
      profileSource: "saved-profile",
      loginVerified: true,
      loginVerifiedMethod: "marker-match",
      separateAccountVerified: false,
      separateAccountVerificationReason: "marker match proves Antigravity CLI model access for this profile path; it does not prove a different Windows credential-store account",
      accountIsolationBoundary: "profile-and-appdata-only",
      accountIsolationCaveat: "Profile isolation only; not proof of a separate Antigravity account. Keep separateAccountVerified:false until explicit account-identity comparison or a truly separate credential namespace.",
    }), "utf8");
    const result = spawnSync(process.execPath, [resolve(root, "scripts", "summarize-anticodex-report.mjs"), reportPath], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.antigravityCliRealSmokeEvidence.separateAccountVerified, false);
    assert.equal(summary.antigravityCliRealSmokeEvidence.accountIsolationCaveat, "Profile isolation only; not proof of a separate Antigravity account. Keep separateAccountVerified:false until explicit account-identity comparison or a truly separate credential namespace.");
    assert.ok(summary.antigravityCliRealSmokeEvidence.accountIsolationBoundary, "accountIsolationBoundary must be retained when separateAccountVerified=false");
    assert.equal(summary.antigravityCliRealSmokeEvidence.separateAccountVerified, false, "summary must not claim dual account verified when separateAccountVerified=false");
    assert.equal(summary.antigravityCliRealSmokeEvidence.strictWindowsAppDataIsolation, true, "strictWindowsAppDataIsolation must be retained when separateAccountVerified=false");
    assert.equal(summary.antigravityCliRealSmokeEvidence.profileSource, "saved-profile", "profileSource must be retained when separateAccountVerified=false");
    assert.equal(summary.antigravityCliRealSmokeEvidence.loginVerified, true, "loginVerified must be retained when separateAccountVerified=false");
    assert.equal(summary.antigravityCliRealSmokeEvidence.loginVerifiedMethod, "marker-match", "loginVerifiedMethod must be retained when separateAccountVerified=false");
    assert.equal(summary.antigravityCliRealSmokeEvidence.separateAccountVerificationReason, "marker match proves Antigravity CLI model access for this profile path; it does not prove a different Windows credential-store account", "separateAccountVerificationReason must be retained when separateAccountVerified=false");
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("summarize-anticodex-report real-smoke sanitizes account identity comparison", () => {
  const tempRoot = mkdtempSync(join(os.tmpdir(), "anticodex-cli-real-smoke-identity-"));
  try {
    const reportPath = join(tempRoot, "latest-antigravity-cli-real-smoke.json");
    writeFileSync(reportPath, JSON.stringify({
      ok: true,
      reportName: "antigravity-cli-real-smoke",
      requestedRealTraffic: true,
      usedRealTraffic: true,
      coverageKind: "real-traffic",
      strictWindowsAppDataIsolation: true,
      profileSource: "saved-profile",
      loginVerified: true,
      loginVerifiedMethod: "marker-match",
      separateAccountVerified: true,
      accountLaneRole: "anticodex-model-text",
      mcpAccountLaneManagedByAntiCodex: false,
      mcpAccountLaneOwner: "external-antigravity-account-not-managed-here",
      accountIdentityComparison: {
        antiCodexAccountId: "anticodex-account-private-id",
        mcpAccountId: "mcp-account-private-id",
        antiCodexSource: "anticodex-cli-real-smoke",
        mcpSource: "external-mcp-antigravity-account",
        comparisonMethod: "explicit-user-approved-account-identity-parameter",
        capturedAt: "2026-06-29T18:00:00.000Z",
        approvalId: "approval-private-test-id",
        approvalSource: "explicit-user-approval",
      },
      accountIsolationBoundary: "profile-and-appdata-only",
      accountIsolationCaveat: "Real account comparison was explicitly approved.",
    }), "utf8");
    const result = spawnSync(process.execPath, [resolve(root, "scripts", "summarize-anticodex-report.mjs"), reportPath], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const summary = JSON.parse(result.stdout);
    assert.deepEqual(summary.antigravityCliRealSmokeEvidence.accountIdentityComparison, {
      antiCodexAccountIdPresent: true,
      mcpAccountIdPresent: true,
      accountIdsDiffer: true,
      antiCodexSourcePresent: true,
      mcpSourcePresent: true,
      comparisonMethodPresent: true,
      capturedAtPresent: true,
      approvalIdPresent: true,
      approvalSourcePresent: true,
    });
    assert.doesNotMatch(result.stdout, /anticodex-account-private-id/);
    assert.doesNotMatch(result.stdout, /mcp-account-private-id/);
    assert.doesNotMatch(result.stdout, /approval-private-test-id/);
    assert.doesNotMatch(result.stdout, /anticodex-cli-real-smoke/);
    assert.doesNotMatch(result.stdout, /external-mcp-antigravity-account/);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("summarize-anticodex-report dual account lanes sanitizes profile paths", () => {
  const tempRoot = mkdtempSync(join(os.tmpdir(), "anticodex-cli-dual-lanes-summary-"));
  try {
    const reportPath = join(tempRoot, "latest-antigravity-cli-dual-account-lanes.json");
    writeFileSync(reportPath, JSON.stringify({
      ok: true,
      reportName: "antigravity-cli-dual-account-lanes",
      noTraffic: true,
      usedRealTraffic: false,
      loginVerified: false,
      separateAccountVerified: false,
      accountLaneRole: "dual-antigravity-cli-account-lanes",
      coverageKind: "dual-account-lanes-prepared-no-traffic",
      antiCodexLane: {
        role: "anticodex-model-text",
        managedByAntiCodex: true,
        profileRoot: "C:\\private\\anticodex-antigravity-account",
      },
      mcpLane: {
        role: "external-mcp-antigravity-account",
        managedByAntiCodex: false,
        profileRoot: "C:\\private\\mcp-antigravity-account",
      },
      laneComparison: {
        profileRootsDifferent: true,
        profileRootsNested: false,
        appDataDifferent: true,
        localAppDataDifferent: true,
        geminiDirDifferent: true,
        neitherUsesDefaultAntigravityProfile: true,
      },
      accountIsolationBoundary: "separate-profile-home-gemini-and-appdata",
      accountIsolationCaveat: "No real traffic.",
    }), "utf8");
    const result = spawnSync(process.execPath, [resolve(root, "scripts", "summarize-anticodex-report.mjs"), reportPath], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const summary = JSON.parse(result.stdout);
    assert.deepEqual(summary.antigravityCliDualAccountLanesEvidence, {
      reportName: "antigravity-cli-dual-account-lanes",
      usedRealTraffic: false,
      loginVerified: false,
      separateAccountVerified: false,
      accountLaneRole: "dual-antigravity-cli-account-lanes",
      coverageKind: "dual-account-lanes-prepared-no-traffic",
      antiCodexLaneRole: "anticodex-model-text",
      mcpLaneRole: "external-mcp-antigravity-account",
      mcpLaneManagedByAntiCodex: false,
      profileRootsDifferent: true,
      profileRootsNested: false,
      appDataDifferent: true,
      localAppDataDifferent: true,
      geminiDirDifferent: true,
      neitherUsesDefaultAntigravityProfile: true,
      accountIsolationBoundary: "separate-profile-home-gemini-and-appdata",
      accountIsolationCaveat: "No real traffic.",
    });
    assert.doesNotMatch(result.stdout, /C:\\\\private/);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("no-traffic Antigravity profile prepare must not be surfaced as real dual-account proof", () => {
  const preflight = readFileSync(resolve(root, "scripts", "test-anticodex-source-preflight.ps1"), "utf8");
  const antigravityCliPrepare = readFileSync(resolve(root, "scripts", "prepare-anticodex-antigravity-cli-profile.ps1"), "utf8");
  const antigravityCliRealSmoke = readFileSync(resolve(root, "scripts", "test-anticodex-antigravity-cli-real-smoke.ps1"), "utf8");
  const findings = readFileSync(resolve(root, "findings.md"), "utf8");
  const taskPlan = readFileSync(resolve(root, "task_plan.md"), "utf8");

  // Source preflight must label profile prepare as no-traffic, never real proof
  assert.match(preflight, /separateAccountVerified.*\$false/);
  assert.match(preflight, /profile-prepared-no-traffic/);
  assert.match(preflight, /latest-antigravity-cli-profile-prepare\.json/);

  // Profile prepare script must default separateAccountVerified to false
  assert.match(antigravityCliPrepare, /separateAccountVerified = \$false/);

  // Real smoke script must default separateAccountVerified to false
  assert.match(antigravityCliRealSmoke, /separateAccountVerified = \$false/);

  // Findings and task plan must not claim that profile prepare alone is real dual-account proof
  assert.doesNotMatch(findings, /profile prepare proves a separate Antigravity account/);
  assert.doesNotMatch(findings, /profile prepare is real dual-account proof/);
  assert.doesNotMatch(taskPlan, /profile prepare proves a separate Antigravity account/);
  assert.doesNotMatch(taskPlan, /profile prepare is real dual-account proof/);

  // Summarizer must surface the no-traffic caveat, not treat profile prepare as verification
  const tempRoot = mkdtempSync(join(os.tmpdir(), "anticodex-no-traffic-profile-proof-"));
  try {
    const reportPath = join(tempRoot, "latest-antigravity-cli-profile-prepare.json");
    writeFileSync(reportPath, JSON.stringify({
      ok: true,
      reportName: "antigravity-cli-profile-prepare",
      separateAccountVerified: false,
      accountIsolationBoundary: "profile-and-appdata-only",
      accountIsolationCaveat: "no real dual-account proof; only AppData isolation verified",
    }), "utf8");
    const result = spawnSync(process.execPath, [resolve(root, "scripts", "summarize-anticodex-report.mjs"), reportPath], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.antigravityCliProfilePrepareEvidence.separateAccountVerified, false, "no-traffic profile prepare must not be surfaced as real dual-account proof");
    assert.match(summary.antigravityCliProfilePrepareEvidence.accountIsolationCaveat, /no real dual-account proof/);
    assert.equal(summary.antigravityCliRealSmokeEvidence, null, "no-traffic profile prepare must not produce real-smoke evidence");
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("diagnostics/sourcePreflight support path must preserve antigravityCliProfilePrepareContract caveat and false verification semantics", () => {
  const diagnostics = readFileSync(resolve(root, "scripts", "test-anticodex-diagnostics.ps1"), "utf8");
  const preflight = readFileSync(resolve(root, "scripts", "test-anticodex-source-preflight.ps1"), "utf8");
  const server = readFileSync(resolve(root, "translator", "adaptive-server.mjs"), "utf8");

  assert.match(diagnostics, /antigravityCliIsolationProfileContract/);
  assert.match(diagnostics, /source-preflight summary isolation profile claims separate account verified/);
  assert.match(diagnostics, /diagnostics source preflight isolation profile claims separate account verified/);
  assert.match(server, /antigravityCliIsolationProfileContract/);

  // Diagnostics verifier must surface the contract object in source preflight summary
  assert.match(diagnostics, /antigravityCliProfilePrepareContract/);

  // Diagnostics verifier must reject a source preflight summary that claims separateAccountVerified is true
  assert.match(diagnostics, /source-preflight summary profile prepare claims separate account verified/);
  assert.match(diagnostics, /diagnostics source preflight profile prepare claims separate account verified/);

  // Diagnostics verifier must reject a source preflight summary with missing accountIsolationCaveat
  assert.match(diagnostics, /source-preflight summary profile prepare missing isolation caveat/);
  assert.match(diagnostics, /diagnostics source preflight profile prepare missing isolation caveat/);

  // Source preflight script must initialize the contract with separateAccountVerified = $false
  assert.match(preflight, /separateAccountVerified = \$false/);
  assert.match(preflight, /separateAccountVerified.*\$false/);

  // Source preflight script must populate accountIsolationCaveat in the contract
  assert.match(preflight, /accountIsolationCaveat/);
  assert.match(preflight, /\$prepareContract\.accountIsolationCaveat/);

  // Adaptive server must surface the contract in sourcePreflightSummary and diagnostics output
  assert.match(server, /antigravityCliProfilePrepareContract/);
  assert.match(server, /accountIsolationCaveat/);
  assert.match(server, /sourcePreflight profilePrepare caveat:/);
});

test("current Manager status uses native-panel-v99 and rejects stale v85/v98 in docs", () => {
  const taskPlan = readFileSync(resolve(root, "task_plan.md"), "utf8");
  const handoff = readFileSync(resolve(root, "docs", "audits", "2026-06-22-handoff-next-channel.md"), "utf8");
  const currentStatus = taskPlan.split("## Goal")[0];
  const handoffCurrentStatus = handoff.split("## Important Recent Checks")[0];

  // Current Manager status sections must declare native-panel-v99
  assert.match(currentStatus, /native-panel-v99/);
  assert.match(handoffCurrentStatus, /native-panel-v99/);

  // Stale Manager version wording must not appear in current-status sections
  assert.doesNotMatch(currentStatus, /native-panel-v85/);
  assert.doesNotMatch(currentStatus, /native-panel-v98/);
  assert.doesNotMatch(handoffCurrentStatus, /native-panel-v85/);
  assert.doesNotMatch(handoffCurrentStatus, /native-panel-v98/);
});

test("Antigravity CLI profile prepare carries account-lane boundary fields and defaults", () => {
  const profilePrepare = readFileSync(resolve(root, "scripts", "prepare-anticodex-antigravity-cli-profile.ps1"), "utf8");
  const upstreamProfile = readFileSync(resolve(root, "scripts", "anticodex-upstream-profile.ps1"), "utf8");

  assert.match(profilePrepare, /accountLaneRole/);
  assert.match(profilePrepare, /mcpAccountLaneManagedByAntiCodex/);
  assert.match(profilePrepare, /mcpAccountLaneOwner/);
  assert.match(upstreamProfile, /accountLaneRole/);
  assert.match(upstreamProfile, /mcpAccountLaneManagedByAntiCodex/);
  assert.match(upstreamProfile, /mcpAccountLaneOwner/);

  assert.match(profilePrepare, /accountLaneRole\s*=\s*"anticodex-model-text"/);
  assert.match(profilePrepare, /mcpAccountLaneManagedByAntiCodex\s*=\s*\$false/);
  assert.match(profilePrepare, /mcpAccountLaneOwner\s*=\s*"external-antigravity-account-not-managed-here"/);
  assert.match(upstreamProfile, /accountLaneRole\s*=\s*"anticodex-model-text"/);
  assert.match(upstreamProfile, /mcpAccountLaneManagedByAntiCodex\s*=\s*\$false/);
  assert.match(upstreamProfile, /mcpAccountLaneOwner\s*=\s*"external-antigravity-account-not-managed-here"/);
});

test("Manager latest reports surface source preflight", () => {
  const managerBridge = readFileSync(resolve(root, "scripts", "anticodex-manager-bridge.mjs"), "utf8");
  const managerInject = readFileSync(resolve(root, "scripts", "anticodex-manager-inject.js"), "utf8");
  const server = readFileSync(resolve(root, "translator", "adaptive-server.mjs"), "utf8");

  // sourcePreflight cliIsolation lane must surface role/mcpManagedHere/mcpOwner in every Manager support path
  assert.match(managerBridge, /sourcePreflight cliIsolation lane: role=/);
  assert.match(managerBridge, /sourcePreflight cliIsolation lane:.*mcpManagedHere=/);
  assert.match(managerBridge, /sourcePreflight cliIsolation lane:.*mcpOwner=/);
  assert.match(managerInject, /sourcePreflight cliIsolation lane: role=/);
  assert.match(managerInject, /sourcePreflight cliIsolation lane:.*mcpManagedHere=/);
  assert.match(managerInject, /sourcePreflight cliIsolation lane:.*mcpOwner=/);
  assert.match(server, /sourcePreflight cliIsolation lane: role=/);
  assert.match(server, /sourcePreflight cliIsolation lane:.*mcpManagedHere=/);
  assert.match(server, /sourcePreflight cliIsolation lane:.*mcpOwner=/);

  // sourcePreflight profilePrepare lane must surface role/mcpManagedHere/mcpOwner in every Manager support path
  assert.match(managerBridge, /sourcePreflight profilePrepare lane: role=/);
  assert.match(managerBridge, /sourcePreflight profilePrepare lane:.*mcpManagedHere=/);
  assert.match(managerBridge, /sourcePreflight profilePrepare lane:.*mcpOwner=/);
  assert.match(managerInject, /sourcePreflight profilePrepare lane: role=/);
  assert.match(managerInject, /sourcePreflight profilePrepare lane:.*mcpManagedHere=/);
  assert.match(managerInject, /sourcePreflight profilePrepare lane:.*mcpOwner=/);
  assert.match(server, /sourcePreflight profilePrepare lane: role=/);
  assert.match(server, /sourcePreflight profilePrepare lane:.*mcpManagedHere=/);
  assert.match(server, /sourcePreflight profilePrepare lane:.*mcpOwner=/);

  // antigravityCliProfilePrepare lane must surface role/mcpManagedHere/mcpOwner in every Manager support path
  assert.match(managerBridge, /antigravityCliProfilePrepare lane: role=/);
  assert.match(managerBridge, /antigravityCliProfilePrepare lane:.*mcpManagedHere=/);
  assert.match(managerBridge, /antigravityCliProfilePrepare lane:.*mcpOwner=/);
  assert.match(managerInject, /antigravityCliProfilePrepare lane: role=/);
  assert.match(managerInject, /antigravityCliProfilePrepare lane:.*mcpManagedHere=/);
  assert.match(managerInject, /antigravityCliProfilePrepare lane:.*mcpOwner=/);
  assert.match(server, /antigravityCliProfilePrepare lane: role=/);
  assert.match(server, /antigravityCliProfilePrepare lane:.*mcpManagedHere=/);
  assert.match(server, /antigravityCliProfilePrepare lane:.*mcpOwner=/);

  // manager inject also keeps the optional real-smoke lane visible
  assert.match(managerInject, /antigravityCliRealSmoke lane: role=/);
  assert.match(managerInject, /antigravityCliRealSmoke lane:.*mcpManagedHere=/);
  assert.match(managerInject, /antigravityCliRealSmoke lane:.*mcpOwner=/);
});

test("Antigravity CLI profile prepare: MCP account lane owner must be the exact sentinel string, not merely non-empty", () => {
  const requiredExact = "external-antigravity-account-not-managed-here";
  const scripts = [
    { name: "test-anticodex-release-gates.mjs", path: resolve(root, "scripts", "test-anticodex-release-gates.mjs") },
    { name: "test-anticodex-diagnostics.ps1", path: resolve(root, "scripts", "test-anticodex-diagnostics.ps1") },
    { name: "test-anticodex-installed-overall.ps1", path: resolve(root, "scripts", "test-anticodex-installed-overall.ps1") },
    { name: "test-anticodex-source-preflight.ps1", path: resolve(root, "scripts", "test-anticodex-source-preflight.ps1") },
  ];
  for (const { name, path } of scripts) {
    const src = readFileSync(path, "utf8");
    assert.match(src, /mcpAccountLaneOwner/, `${name} must reference mcpAccountLaneOwner`);
    assert.match(src, new RegExp(requiredExact), `${name} must compare against exact MCP account lane owner sentinel`);
    assert.doesNotMatch(src, /-not \[string\]\$profilePrepare(?:Contract|Evidence)\.mcpAccountLaneOwner/, `${name} must not only check owner non-empty`);
    assert.doesNotMatch(src, /!contract\.mcpAccountLaneOwner/, `${name} must not only check owner non-empty`);
  }
});

test("Antigravity CLI Windows-user readiness is report-only and surfaced before login", () => {
  const secondAccountReadinessSummary = readFileSync(resolve(root, "scripts", "test-anticodex-second-account-readiness-summary.ps1"), "utf8");
  const readiness = readFileSync(resolve(root, "scripts", "test-anticodex-antigravity-cli-windows-user-readiness.ps1"), "utf8");
  const prepare = readFileSync(resolve(root, "scripts", "test-anticodex-windows-user-account-prepare.ps1"), "utf8");
  const status = readFileSync(resolve(root, "scripts", "test-anticodex-antigravity-account-isolation-status.ps1"), "utf8");
  const dryRunLauncher = readFileSync(resolve(root, "scripts", "start-anticodex-antigravity-cli-login-windows-user.ps1"), "utf8");
  const secondAccountLogin = readFileSync(resolve(root, "scripts", "start-anticodex-second-antigravity-account-login.ps1"), "utf8");
  const secondAccountLoginReport = readFileSync(resolve(root, "scripts", "test-anticodex-second-account-login-entrypoint.ps1"), "utf8");
  const secondAccountPostLoginProof = readFileSync(resolve(root, "scripts", "test-anticodex-second-account-post-login-proof.ps1"), "utf8");
  const setupGuidance = readFileSync(resolve(root, "scripts", "test-anticodex-windows-user-setup-guidance.ps1"), "utf8");
  const jsonInvoker = readFileSync(resolve(root, "scripts", "anticodex-powershell-json-invoke.ps1"), "utf8");
  const summarizer = readFileSync(resolve(root, "scripts", "summarize-anticodex-report.mjs"), "utf8");
  const diagnostics = readFileSync(resolve(root, "scripts", "collect-anticodex-diagnostics.ps1"), "utf8");
  const diagnosticsTest = readFileSync(resolve(root, "scripts", "test-anticodex-diagnostics.ps1"), "utf8");
  const installedOverall = readFileSync(resolve(root, "scripts", "test-anticodex-installed-overall.ps1"), "utf8");
  const syncRuntime = readFileSync(resolve(root, "scripts", "sync-anticodex-runtime.ps1"), "utf8");
  const releaseGates = readFileSync(resolve(root, "scripts", "test-anticodex-release-gates.mjs"), "utf8");
  const managerBridge = readFileSync(resolve(root, "scripts", "anticodex-manager-bridge.mjs"), "utf8");
  const managerInject = readFileSync(resolve(root, "scripts", "anticodex-manager-inject.js"), "utf8");
  const server = readFileSync(resolve(root, "translator", "adaptive-server.mjs"), "utf8");
  const antigravityCliRealSmoke = readFileSync(resolve(root, "scripts", "test-anticodex-antigravity-cli-real-smoke.ps1"), "utf8");
  const goalReadiness = readFileSync(resolve(root, "scripts", "test-anticodex-goal-readiness.mjs"), "utf8");

  assert.match(jsonInvoker, /Invoke-AntiCodexPowerShellJsonScript/);
  for (const [name, src] of [
    ["secondAccountReadinessSummary", secondAccountReadinessSummary],
    ["readiness", readiness],
    ["prepare", prepare],
    ["setupGuidance", setupGuidance],
    ["status", status],
    ["secondAccountLogin", secondAccountLogin],
    ["secondAccountLoginReport", secondAccountLoginReport],
    ["secondAccountPostLoginProof", secondAccountPostLoginProof],
  ]) {
    assert.match(src, /anticodex-powershell-json-invoke\.ps1/, `${name} must use the shared in-process PowerShell JSON invoker`);
    assert.match(src, /Invoke-AntiCodexPowerShellJsonScript/, `${name} must invoke PowerShell JSON subreports in-process`);
    assert.doesNotMatch(src, /&\s+powershell\.exe\s+-NoProfile\s+-ExecutionPolicy\s+Bypass\s+-File/, `${name} must not spawn nested powershell.exe for subreports`);
  }

  assert.match(antigravityCliRealSmoke, /\[string\]\$WindowsUser/);

  assert.match(secondAccountReadinessSummary, /reportName\s*=\s*"second-account-readiness-summary"/);
  assert.match(secondAccountReadinessSummary, /test-anticodex-windows-user-account-prepare\.ps1/);
  assert.match(secondAccountReadinessSummary, /test-anticodex-windows-user-setup-guidance\.ps1/);
  assert.match(secondAccountReadinessSummary, /test-anticodex-antigravity-account-isolation-status\.ps1/);
  assert.match(secondAccountReadinessSummary, /test-anticodex-second-account-login-entrypoint\.ps1/);
  assert.match(secondAccountReadinessSummary, /test-anticodex-approved-real-run-sequence\.mjs/);
  assert.match(secondAccountReadinessSummary, /test-anticodex-goal-readiness\.mjs/);
  assert.match(secondAccountReadinessSummary, /Test-ReportCollected/);
  assert.match(secondAccountReadinessSummary, /\$goalResult\.ok\s*=\s*\$true/);
  assert.match(secondAccountReadinessSummary, /test-anticodex-release-gates\.mjs --compact-status/);
  assert.match(secondAccountReadinessSummary, /latest-second-account-readiness-summary\.json/);
  assert.match(secondAccountReadinessSummary, /readyForOperatorLogin/);
  assert.match(secondAccountReadinessSummary, /currentWindowsUserSid/);
  assert.match(secondAccountReadinessSummary, /targetWindowsUserSid/);
  assert.match(secondAccountReadinessSummary, /targetUserSidMatchesCurrentUser/);
  assert.match(secondAccountReadinessSummary, /targetUserIdentityBoundaryOk/);
  assert.match(secondAccountReadinessSummary, /targetUserIsCurrentUser/);
  assert.match(secondAccountReadinessSummary, /nextOperatorAction/);
  assert.match(secondAccountReadinessSummary, /operatorChecklistStages/);
  assert.match(secondAccountReadinessSummary, /operatorChecklistStartsLoginCount/);
  assert.match(secondAccountReadinessSummary, /operatorChecklistUsesRealTrafficCount/);
  assert.match(secondAccountReadinessSummary, /manualSetupCommandHint/);
  assert.match(secondAccountReadinessSummary, /approvedLoginCommandTemplate/);
  assert.match(secondAccountReadinessSummary, /postLoginProofCommandTemplate/);
  assert.match(secondAccountReadinessSummary, /postLoginProofCommandTemplate[\s\S]*-WindowsUser/);
  assert.match(secondAccountReadinessSummary, /postLoginProofCommandTemplateHasWindowsUser/);
  assert.match(secondAccountReadinessSummary, /requestedRealTraffic\s*=\s*\$false/);
  assert.match(secondAccountReadinessSummary, /usedRealTraffic\s*=\s*\$false/);
  assert.match(secondAccountReadinessSummary, /changedSystem\s*=\s*\$false/);
  assert.match(secondAccountReadinessSummary, /createdUser\s*=\s*\$false/);
  assert.match(secondAccountReadinessSummary, /startedLogin\s*=\s*\$false/);
  assert.match(secondAccountReadinessSummary, /capturesPassword\s*=\s*\$false/);
  assert.match(secondAccountReadinessSummary, /storesPassword\s*=\s*\$false/);
  assert.match(summarizer, /accountIsolationCaveat:\s*has\(report, "accountIsolationCaveat"\)/);
  assert.match(diagnosticsTest, /second-account readiness summary caveat missing/);
  assert.doesNotMatch(secondAccountReadinessSummary, /New-LocalUser|Add-LocalGroupMember|Start-Process|Invoke-RestMethod|Invoke-WebRequest|AllowRealTraffic|StartLoginApproval|\.env/);
  assert.match(summarizer, /secondAccountReadinessSummaryEvidence/);
  assert.match(summarizer, /secondAccountReadinessSummaryEvidence:[\s\S]*targetUserIdentityBoundaryOk/);
  assert.match(diagnosticsTest, /second-account readiness summary identity boundary unverified/);
  assert.match(summarizer, /secondAccountReadinessSummaryEvidence:[\s\S]*operatorChecklistStages/);
  assert.match(summarizer, /secondAccountReadinessSummaryEvidence:[\s\S]*operatorChecklistStartsLoginCount/);
  assert.match(summarizer, /secondAccountReadinessSummaryEvidence:[\s\S]*manualSetupCommandHint/);
  assert.match(diagnosticsTest, /Test-SecondAccountReadinessSummaryEvidence/);
  assert.match(diagnosticsTest, /diagnostic reports summary missing latest-second-account-readiness-summary\.json/);
  assert.match(installedOverall, /latest-second-account-readiness-summary\.json/);
  assert.match(releaseGates, /secondAccountReadinessSummary/);
  assert.match(releaseGates, /latest-second-account-readiness-summary\.json/);
  assert.match(releaseGates, /requireSecondAccountReadinessSummarySemantics/);
  assert.match(releaseGates, /second_account_readiness_summary_identity_boundary_unverified/);
  assert.match(releaseGates, /test-anticodex-second-account-readiness-summary\.ps1/);
  assert.match(server, /latest-second-account-readiness-summary\.json/);
  assert.match(server, /secondAccountReadinessSummary identity/);

  assert.match(readiness, /reportName\s*=\s*"antigravity-cli-windows-user-readiness"/);
  assert.match(readiness, /start-anticodex-antigravity-cli-login-windows-user\.ps1/);
  assert.match(readiness, /-DryRun/);
  assert.match(readiness, /usedRealTraffic\s*=\s*\$false/);
  assert.match(readiness, /started\s*=\s*if \(\$dryRun\) \{ \[bool\]\$dryRun\.started \} else \{ \$false \}/);
  assert.match(readiness, /capturesLoginOutput\s*=\s*if \(\$dryRun\) \{ \[bool\]\$dryRun\.capturesLoginOutput \} else \{ \$false \}/);
  assert.match(readiness, /currentWindowsUserSid/);
  assert.match(readiness, /targetWindowsUserSid/);
  assert.match(readiness, /targetUserSidMatchesCurrentUser/);
  assert.match(readiness, /targetUserIdentityBoundaryOk/);
  assert.match(readiness, /separateAccountVerified\s*=\s*\$false/);
  assert.match(readiness, /loginVerified\s*=\s*\$false/);
  assert.match(readiness, /create_target_windows_user/);
  assert.match(readiness, /choose_different_windows_user/);
  assert.match(readiness, /verify_windows_user_manually/);
  assert.match(readiness, /run_interactive_login_with_explicit_user_approval/);
  assert.match(readiness, /latest-antigravity-cli-windows-user-readiness\.json/);
  assert.doesNotMatch(readiness, /New-LocalUser|Add-LocalGroupMember|Start-Process|Invoke-RestMethod|Invoke-WebRequest|\.env/);

  assert.match(prepare, /reportName\s*=\s*"windows-user-account-prepare"/);
  assert.match(prepare, /test-anticodex-antigravity-cli-windows-user-readiness\.ps1/);
  assert.match(prepare, /changedSystem\s*=\s*\$false/);
  assert.match(prepare, /createdUser\s*=\s*\$false/);
  assert.match(prepare, /startedLogin\s*=\s*\$false/);
  assert.match(prepare, /capturesPassword\s*=\s*\$false/);
  assert.match(prepare, /storesPassword\s*=\s*\$false/);
  assert.match(prepare, /currentWindowsUserSid/);
  assert.match(prepare, /targetWindowsUserSid/);
  assert.match(prepare, /targetUserSidMatchesCurrentUser/);
  assert.match(prepare, /targetUserIdentityBoundaryOk/);
  assert.match(prepare, /currentProcessElevated/);
  assert.match(prepare, /canCreateTargetWindowsUser/);
  assert.match(prepare, /create_target_windows_user_with_explicit_user_approval/);
  assert.match(prepare, /open_elevated_windows_user_settings/);
  assert.match(prepare, /safeToAskUserForSecondAccountLogin/);
  assert.match(prepare, /blockedBeforeInteractiveLogin/);
  assert.match(prepare, /operatorBlockingStage/);
  assert.match(prepare, /operatorNextStep/);
  assert.match(prepare, /setupActionRequired/);
  assert.match(prepare, /canProceedToInteractiveLogin/);
  assert.match(prepare, /requiresUserPresence/);
  assert.match(prepare, /target_user_missing_blocked_before_login/);
  assert.match(prepare, /open_elevated_windows_user_settings_then_rerun_prepare/);
  assert.match(prepare, /latest-windows-user-account-prepare\.json/);
  assert.doesNotMatch(prepare, /^\s*(?:&\s*)?New-LocalUser\b/m);
  assert.doesNotMatch(prepare, /Add-LocalGroupMember|Start-Process|Invoke-RestMethod|Invoke-WebRequest|\.env/);

  assert.match(status, /reportName\s*=\s*"antigravity-account-isolation-status"/);
  assert.match(status, /test-anticodex-antigravity-cli-dual-account-lanes\.ps1/);
  assert.match(status, /test-anticodex-antigravity-cli-windows-user-readiness\.ps1/);
  assert.match(status, /test-anticodex-windows-user-account-prepare\.ps1/);
  assert.match(status, /latest-antigravity-account-isolation-status\.json/);
  assert.match(status, /mcpAccountLaneOwner\s*=\s*"external-antigravity-account-not-managed-here"/);
  assert.match(status, /currentWindowsUserSid/);
  assert.match(status, /targetWindowsUserSid/);
  assert.match(status, /targetUserSidMatchesCurrentUser/);
  assert.match(status, /targetUserIdentityBoundaryOk/);
  assert.match(status, /finalProofPlan/);
  assert.match(status, /postLoginProofPlan/);
  assert.match(status, /proofScript = "test-anticodex-antigravity-cli-real-smoke\.ps1"/);
  assert.match(status, /requiresInteractiveLoginComplete = \$true/);
  assert.match(status, /requiresSeparateAccountProofApproval = \$true/);
  assert.match(status, /requiredAccountIdentityInputs = @\("AntiCodexAccountId", "McpAccountId"\)/);
  assert.match(status, /commandTemplate/);
  assert.match(status, /-AllowSeparateAccountProof/);
  assert.match(status, /-SeparateAccountProofApprovalId <explicit-user-approval-id>/);
  assert.match(status, /commandTemplate[\s\S]*?-WindowsUser <target-windows-user>/);
  assert.match(status, /requiresSeparateWindowsUserCredentialBoundary/);
  assert.match(status, /requiresInteractiveLogin/);
  assert.match(status, /requiresApprovedRealTraffic/);
  assert.match(status, /requiresDistinctAccountIdentityComparison/);
  assert.match(status, /accountIdsMustDiffer/);
  assert.match(status, /releaseAcceptableAccountProof\s*=\s*\$false/);
  assert.doesNotMatch(status, /New-LocalUser|Add-LocalGroupMember|Start-Process|Invoke-RestMethod|Invoke-WebRequest|\.env/);

  assert.match(dryRunLauncher, /readinessChecked/);
  assert.match(dryRunLauncher, /target_windows_user_missing/);
  assert.match(dryRunLauncher, /safeToAskUserForSecondAccountLogin/);
  assert.match(dryRunLauncher, /canProceedToInteractiveLogin/);
  assert.match(dryRunLauncher, /blockedBeforeInteractiveLogin/);
  assert.match(dryRunLauncher, /operatorBlockingStage/);
  assert.match(dryRunLauncher, /operatorNextStep/);
  assert.match(dryRunLauncher, /currentWindowsUserSid/);
  assert.match(dryRunLauncher, /targetWindowsUserSid/);
  assert.match(dryRunLauncher, /targetUserSidMatchesCurrentUser/);
  assert.match(dryRunLauncher, /targetUserIdentityBoundaryOk/);
  assert.match(dryRunLauncher, /windows_user_not_ready_for_interactive_login/);
  assert.match(dryRunLauncher, /exit 2/);
  assert.match(dryRunLauncher, /\$runasWorkingDirectory = Join-Path \$env:SystemRoot "System32"/);
  assert.match(dryRunLauncher, /runasWorkingDirectory = \$runasWorkingDirectory/);
  assert.match(dryRunLauncher, /bootstrapKeepsShellOpen = \$false/);
  assert.match(dryRunLauncher, /Start-Process -FilePath "runas\.exe" -ArgumentList \$result\.runasArgs -WorkingDirectory \$runasWorkingDirectory/);
  assert.doesNotMatch(dryRunLauncher, /"powershell\.exe",\s*[\r\n]+\s*"-NoExit"/);
  assert.doesNotMatch(dryRunLauncher, /New-LocalUser|Add-LocalGroupMember/);
  assert.doesNotMatch(dryRunLauncher, /Invoke-RestMethod|Invoke-WebRequest|\.env/);

  assert.match(secondAccountLogin, /reportName = "second-antigravity-account-login-entrypoint"/);
  assert.match(secondAccountLogin, /test-anticodex-antigravity-account-isolation-status\.ps1/);
  assert.match(secondAccountLogin, /start-anticodex-antigravity-cli-login-windows-user\.ps1/);
  assert.match(secondAccountLogin, /StartLoginApproval/);
  assert.match(secondAccountLogin, /start-separate-windows-user-login/);
  assert.match(secondAccountLogin, /approvedLoginCommandTemplate/);
  assert.match(secondAccountLogin, /nextNoTrafficStatusCommand/);
  assert.match(secondAccountLogin, /postLoginProofCommandTemplate/);
  assert.match(secondAccountLogin, /postLoginProofCommandTemplate[\s\S]*-WindowsUser/);
  assert.match(secondAccountLogin, /postLoginProofCommandTemplateHasWindowsUser/);
  assert.match(secondAccountLogin, /canRunPostLoginProof/);
  assert.match(secondAccountLogin, /postLoginProofPlan/);
  assert.match(secondAccountLogin, /explicit_start_login_approval_missing/);
  assert.match(secondAccountLogin, /second_account_login_not_ready/);
  assert.match(secondAccountLogin, /safeToStartLogin/);
  assert.match(secondAccountLogin, /requestedRealTraffic = \$false/);
  assert.match(secondAccountLogin, /behaviorCovered = \$true/);
  assert.match(secondAccountLogin, /coverageKind = "second-account-login-entrypoint-direct"/);
  assert.match(secondAccountLogin, /changedSystem = \$false/);
  assert.match(secondAccountLogin, /createdUser = \$false/);
  assert.match(secondAccountLogin, /capturesPassword = \$false/);
  assert.match(secondAccountLogin, /storesPassword = \$false/);
  assert.match(secondAccountLogin, /accountIsolationCaveat/);
  assert.doesNotMatch(secondAccountLogin, /New-LocalUser|Add-LocalGroupMember|Invoke-RestMethod|Invoke-WebRequest|\.env/);

  const secondAccountManagerAction = server.match(/secondAccountLoginStatus:\s*\{[\s\S]*?\n    \},/)?.[0] || "";
  assert.match(secondAccountManagerAction, /script: "start-anticodex-second-antigravity-account-login\.ps1"/);
  assert.match(secondAccountManagerAction, /args: \[\]/);
  assert.match(secondAccountManagerAction, /foregroundSingleton: true/);
  assert.doesNotMatch(secondAccountManagerAction, /StartLogin|StartLoginApproval|AllowRealTraffic|AllowSeparateAccountProof/);
  assert.match(managerInject, /\["secondAccountLoginStatus", "\\u7b2c\\u4e8c Antigravity/);
  assert.match(managerInject, /action === "secondAccountLoginStatus"[\s\S]*\\u7b2c\\u4e8c Antigravity \\u8d26\\u53f7\\u72b6\\u6001\\u68c0\\u67e5/);
  assert.match(managerInject, /action === "secondAccountLoginStatus"[\s\S]*\\u767b\\u5f55\\u51c6\\u5907/);
  assert.match(managerInject, /action === "secondAccountLoginStatus"[\s\S]*operatorBlockingStage/);
  assert.match(managerInject, /action === "secondAccountLoginStatus"[\s\S]*operatorNextStep/);
  assert.match(managerInject, /operatorStepDisplayText/);
  assert.match(managerInject, /open_elevated_windows_user_settings_then_rerun_prepare[\s\S]*\\u6253\\u5f00 Windows \\u8bbe\\u7f6e/);
  assert.match(server, /data-manager-action="secondAccountLoginStatus"/);

  assert.match(secondAccountLoginReport, /reportName = "second-antigravity-account-login-entrypoint"/);
  assert.match(secondAccountLoginReport, /latest-second-antigravity-account-login-entrypoint\.json/);
  assert.match(secondAccountLoginReport, /changedSystem = \$false/);
  assert.match(secondAccountLoginReport, /createdUser = \$false/);
  assert.match(secondAccountLoginReport, /missingApprovalBlocked/);
  assert.match(secondAccountLoginReport, /approvedStartBlockedByStatusGate/);
  assert.match(secondAccountLoginReport, /statusOnlySafetyFieldsOk/);
  assert.match(secondAccountLoginReport, /WindowsIdentity\]::GetCurrent\(\)\.Name/);
  assert.match(secondAccountLoginReport, /sameWindowsUserReportRoot/);
  assert.match(secondAccountLoginReport, /GetTempPath\(\)/);
  assert.match(secondAccountLoginReport, /target_windows_user_is_current_user/);
  assert.match(secondAccountLoginReport, /sameWindowsUserTargetBlocked/);
  assert.match(secondAccountLoginReport, /sameWindowsUserTargetBlockingReason/);
  assert.match(secondAccountLoginReport, /sameWindowsUserTargetStartedLogin/);
  assert.match(secondAccountLoginReport, /sameWindowsUserTargetSafetyFieldsOk/);
  assert.match(secondAccountLoginReport, /entrypoint_requested_real_traffic/);
  assert.match(secondAccountLoginReport, /entrypoint_changed_system/);
  assert.match(secondAccountLoginReport, /entrypoint_created_user/);
  assert.match(secondAccountLoginReport, /capturesPassword = \$false/);
  assert.match(secondAccountLoginReport, /storesPassword = \$false/);
  assert.match(secondAccountLoginReport, /StartLoginApproval", "start-separate-windows-user-login"/);
  assert.match(secondAccountLoginReport, /approvedLoginCommandTemplate/);
  assert.match(secondAccountLoginReport, /nextNoTrafficStatusCommand/);
  assert.match(secondAccountLoginReport, /postLoginProofCommandTemplate/);
  assert.match(secondAccountLoginReport, /postLoginProofCommandTemplate[\s\S]*-WindowsUser/);
  assert.match(secondAccountLoginReport, /postLoginProofCommandTemplateHasWindowsUser/);
  assert.match(secondAccountLoginReport, /canRunPostLoginProof/);
  assert.match(secondAccountLoginReport, /postLoginProofPlan/);
  assert.match(secondAccountLoginReport, /releaseAcceptableAccountProof = \$false/);
  assert.doesNotMatch(secondAccountLoginReport, /New-LocalUser|Add-LocalGroupMember|Invoke-RestMethod|Invoke-WebRequest|\.env/);

  assert.match(setupGuidance, /reportName = "windows-user-setup-guidance"/);
  assert.match(setupGuidance, /test-anticodex-windows-user-account-prepare\.ps1/);
  assert.match(setupGuidance, /latest-windows-user-setup-guidance\.json/);
  assert.match(setupGuidance, /guidanceSource = "windows-user-account-prepare"/);
  assert.match(setupGuidance, /changedSystem = \$false/);
  assert.match(setupGuidance, /createdUser = \$false/);
  assert.match(setupGuidance, /startedLogin = \$false/);
  assert.match(setupGuidance, /capturesPassword = \$false/);
  assert.match(setupGuidance, /storesPassword = \$false/);
  assert.match(setupGuidance, /opensSettings = \$false/);
  assert.match(setupGuidance, /runsSystemUserCommand = \$false/);
  assert.match(setupGuidance, /currentWindowsUserSid/);
  assert.match(setupGuidance, /targetWindowsUserSid/);
  assert.match(setupGuidance, /targetUserSidMatchesCurrentUser/);
  assert.match(setupGuidance, /targetUserIdentityBoundaryOk/);
  assert.match(setupGuidance, /releaseAcceptableAccountProof = \$false/);
  assert.match(setupGuidance, /operatorSetupPlan = \[ordered\]@\{/);
  assert.match(setupGuidance, /targetLocalWindowsUser = "AntiCodexModel"/);
  assert.match(setupGuidance, /setupMode = "manual-only"/);
  assert.match(setupGuidance, /preferredSurface = "windows-settings-other-users"/);
  assert.match(setupGuidance, /antiCodexCreatesUser = \$false/);
  assert.match(setupGuidance, /antiCodexOpensSettings = \$false/);
  assert.match(setupGuidance, /antiCodexStartsLogin = \$false/);
  assert.match(setupGuidance, /antiCodexCapturesPassword = \$false/);
  assert.match(setupGuidance, /antiCodexStoresPassword = \$false/);
  assert.match(setupGuidance, /antiCodexUsesRealTraffic = \$false/);
  assert.match(setupGuidance, /rawUserManagementCommandProvided = \$false/);
  assert.match(setupGuidance, /afterManualSetupChecks = @\(/);
  assert.match(setupGuidance, /finalLoginEntrypoint = "start-anticodex-second-antigravity-account-login\.ps1"/);
  assert.match(setupGuidance, /finalLoginApproval = "start-separate-windows-user-login"/);
  assert.match(setupGuidance, /readinessCheckSequence = @\(/);
  assert.match(setupGuidance, /"create_target_windows_user"/);
  assert.match(setupGuidance, /"windows_user_account_prepare"/);
  assert.match(setupGuidance, /"account_isolation_status"/);
  assert.match(setupGuidance, /"second_account_login_entrypoint_with_explicit_approval"/);
  assert.match(setupGuidance, /operatorChecklist = @\(/);
  assert.match(setupGuidance, /stage = "create_target_windows_user"/);
  assert.match(setupGuidance, /stage = "windows_user_account_prepare"/);
  assert.match(setupGuidance, /stage = "account_isolation_status"/);
  assert.match(setupGuidance, /stage = "second_account_login_entrypoint_with_explicit_approval"/);
  assert.match(setupGuidance, /startsLogin = \$true/);
  assert.match(setupGuidance, /usesRealTraffic = \$false/);
  assert.doesNotMatch(setupGuidance, /New-LocalUser|Add-LocalGroupMember|Start-Process|Invoke-RestMethod|Invoke-WebRequest|\.env/);

  assert.match(summarizer, /runasWorkingDirectory/);
  assert.match(summarizer, /bootstrapKeepsShellOpen/);
  assert.match(summarizer, /secondAccountLoginEntrypointEvidence/);
  assert.match(summarizer, /sameWindowsUserTargetBlocked/);
  assert.match(summarizer, /sameWindowsUserTargetBlockingReason/);
  assert.match(summarizer, /sameWindowsUserTargetStartedLogin/);
  assert.match(summarizer, /sameWindowsUserTargetSafetyFieldsOk/);
  assert.match(summarizer, /approvedLoginCommandTemplate/);
  assert.match(summarizer, /nextNoTrafficStatusCommand/);
  assert.match(summarizer, /postLoginProofCommandTemplate/);
  assert.match(summarizer, /canRunPostLoginProof/);
  assert.match(summarizer, /windowsUserSetupGuidanceEvidence/);
  assert.match(summarizer, /readinessCheckSequence/);
  assert.match(summarizer, /operatorChecklistStages/);
  assert.match(summarizer, /operatorChecklistStartsLoginCount/);
  assert.match(summarizer, /operatorChecklistUsesRealTrafficCount/);
  assert.match(summarizer, /operatorSetupPlan/);
  assert.match(summarizer, /rawUserManagementCommandProvided/);
  assert.match(summarizer, /currentWindowsUserSidPresent/);
  assert.match(summarizer, /targetWindowsUserSidPresent/);
  assert.match(summarizer, /targetUserIdentityBoundaryOk/);
  assert.match(summarizer, /isAntigravityCliWindowsUserReadinessReport/);
  assert.match(summarizer, /antigravityCliWindowsUserReadinessEvidence/);
  assert.match(summarizer, /isWindowsUserAccountPrepareReport/);
  assert.match(summarizer, /windowsUserAccountPrepareEvidence/);
  assert.match(summarizer, /safeToAskUserForSecondAccountLogin/);
  assert.match(summarizer, /operatorBlockingStage/);
  assert.match(summarizer, /canProceedToInteractiveLogin/);
  assert.match(summarizer, /antigravityAccountIsolationStatusEvidence/);
  assert.match(summarizer, /releaseAcceptableAccountProof/);
  assert.match(summarizer, /finalProofPlan/);
  assert.match(summarizer, /postLoginProofPlan/);
  assert.match(summarizer, /proofScript/);
  assert.match(summarizer, /commandTemplate/);
  assert.match(summarizer, /requiredAccountIdentityInputs/);
  assert.match(summarizer, /requiresDistinctAccountIdentityComparison/);
  assert.match(diagnostics, /latest-antigravity-cli-windows-user-readiness\.json/);
  assert.match(diagnostics, /antigravityCliIsolationProfileContract/);
  assert.match(diagnostics, /antigravityCliDualAccountLanesOk/);
  assert.match(diagnostics, /antigravityCliDualAccountLanesContract/);
  assert.match(diagnostics, /antigravityCliProfilePrepareRejectsDefaultChildOk/);
  assert.match(diagnostics, /antigravityCliWindowsUserReadinessEvidence/);
  assert.match(diagnostics, /antigravityCliDualAccountLanesEvidence/);
  assert.match(diagnostics, /latest-windows-user-account-prepare\.json/);
  assert.match(diagnostics, /windowsUserAccountPrepareEvidence/);
  assert.match(diagnostics, /latest-windows-user-setup-guidance\.json/);
  assert.match(diagnostics, /windowsUserSetupGuidanceEvidence/);
  assert.match(diagnostics, /latest-antigravity-account-isolation-status\.json/);
  assert.match(diagnostics, /latest-second-antigravity-account-login-entrypoint\.json/);
  assert.match(diagnosticsTest, /runasWorkingDirectory/);
  assert.match(diagnosticsTest, /bootstrapKeepsShellOpen/);
  assert.match(diagnosticsTest, /runas working directory/);
  assert.match(diagnosticsTest, /keeps bootstrap shell open/);
  assert.match(diagnosticsTest, /windowsUserSetupGuidanceEvidence/);
  assert.match(diagnosticsTest, /operatorSetupPlan/);
  assert.match(diagnosticsTest, /targetLocalWindowsUser/);
  assert.match(diagnosticsTest, /setupMode/);
  assert.match(diagnosticsTest, /preferredSurface/);
  assert.match(diagnosticsTest, /rawUserManagementCommandProvided/);
  assert.match(diagnosticsTest, /afterManualSetupChecks/);
  assert.match(diagnosticsTest, /finalLoginEntrypoint/);
  assert.match(diagnosticsTest, /finalLoginApproval/);
  assert.match(diagnosticsTest, /Test-SecondAccountLoginEntrypointSummaryEvidence/);
  assert.match(diagnosticsTest, /sameWindowsUserTargetBlocked/);
  assert.match(diagnosticsTest, /sameWindowsUserTargetBlockingReason/);
  assert.match(diagnosticsTest, /sameWindowsUserTargetStartedLogin/);
  assert.match(diagnosticsTest, /sameWindowsUserTargetSafetyFieldsOk/);
  assert.match(diagnosticsTest, /second-account entrypoint summary same Windows user not blocked/);
  assert.match(diagnosticsTest, /second-account entrypoint summary approved login command missing/);
  assert.match(diagnosticsTest, /second-account entrypoint summary post-login proof plan missing/);
  assert.match(diagnosticsTest, /second-account entrypoint summary post-login proof MCP owner mismatch/);
  assert.match(diagnosticsTest, /setup plan provides raw user command/);
  assert.match(diagnosticsTest, /"windows_user_account_prepare"/);
  assert.match(diagnosticsTest, /"account_isolation_status"/);
  assert.match(diagnosticsTest, /"start-anticodex-second-antigravity-account-login\.ps1"/);
  assert.match(diagnosticsTest, /"start-separate-windows-user-login"/);
  assert.match(installedOverall, /latest-antigravity-cli-windows-user-readiness\.json/);
  assert.match(installedOverall, /latest-windows-user-account-prepare\.json/);
  assert.match(installedOverall, /latest-windows-user-setup-guidance\.json/);
  assert.match(installedOverall, /latest-antigravity-account-isolation-status\.json/);
  assert.match(installedOverall, /latest-second-antigravity-account-login-entrypoint\.json/);
  assert.match(syncRuntime, /test-anticodex-antigravity-cli-windows-user-readiness\.ps1/);
  assert.match(syncRuntime, /test-anticodex-windows-user-account-prepare\.ps1/);
  assert.match(syncRuntime, /test-anticodex-windows-user-setup-guidance\.ps1/);
  assert.match(syncRuntime, /test-anticodex-antigravity-account-isolation-status\.ps1/);
  assert.match(syncRuntime, /scripts\\anticodex-powershell-json-invoke\.ps1/);
  assert.match(syncRuntime, /test-anticodex-second-account-readiness-summary\.ps1/);
  assert.match(syncRuntime, /start-anticodex-second-antigravity-account-login\.ps1/);
  assert.match(syncRuntime, /test-anticodex-second-account-login-entrypoint\.ps1/);
  assert.match(releaseGates, /scripts\/test-anticodex-antigravity-cli-windows-user-readiness\.ps1/);
  assert.match(releaseGates, /scripts\/test-anticodex-windows-user-account-prepare\.ps1/);
  assert.match(releaseGates, /scripts\/test-anticodex-windows-user-setup-guidance\.ps1/);
  assert.match(releaseGates, /scripts\/test-anticodex-antigravity-account-isolation-status\.ps1/);
  assert.match(releaseGates, /scripts\/start-anticodex-second-antigravity-account-login\.ps1/);
  assert.match(releaseGates, /scripts\/test-anticodex-second-account-login-entrypoint\.ps1/);
  assert.match(releaseGates, /antigravityCliWindowsUserReadiness/);
  assert.match(releaseGates, /requireAntigravityCliWindowsUserReadinessSemantics/);
  assert.match(releaseGates, /second_account_entrypoint_same_windows_user_not_blocked/);
  assert.match(releaseGates, /second_account_entrypoint_same_windows_user_reason/);
  assert.match(releaseGates, /second_account_entrypoint_same_windows_user_started_login/);
  assert.match(releaseGates, /second_account_entrypoint_same_windows_user_safety_fields/);
  assert.match(releaseGates, /windowsUserAccountPrepare/);
  assert.match(releaseGates, /requireWindowsUserAccountPrepareSemantics/);
  assert.match(releaseGates, /windowsUserSetupGuidance/);
  assert.match(releaseGates, /requireWindowsUserSetupGuidanceSemantics/);
  assert.match(releaseGates, /antigravityAccountIsolationStatus/);
  assert.match(releaseGates, /requireAntigravityAccountIsolationStatusSemantics/);
  assert.match(releaseGates, /account_isolation_status_post_login_proof_plan_missing/);
  assert.match(releaseGates, /account_isolation_status_post_login_proof_command_missing/);
  assert.match(releaseGates, /account_isolation_status_post_login_proof_requires_identity/);
  assert.match(releaseGates, /account_isolation_status_post_login_proof_wrong_boundary/);
  assert.match(releaseGates, /windows_user_readiness_started_login/);
  assert.match(releaseGates, /windows_user_readiness_target_sid_matches_current_user/);
  assert.match(releaseGates, /windows_user_readiness_identity_boundary_unverified/);
  assert.match(releaseGates, /windows_user_prepare_changed_system/);
  assert.match(releaseGates, /windows_user_prepare_target_sid_matches_current_user/);
  assert.match(releaseGates, /windows_user_prepare_identity_boundary_unverified/);
  assert.match(releaseGates, /windows_user_prepare_captures_password/);
  assert.match(releaseGates, /windows_user_prepare_next_proof_real_traffic_missing/);
  assert.match(releaseGates, /windows_user_setup_guidance_changed_system/);
  assert.match(releaseGates, /windows_user_setup_guidance_started_login/);
  assert.match(releaseGates, /windows_user_setup_guidance_target_sid_matches_current_user/);
  assert.match(releaseGates, /windows_user_setup_guidance_identity_boundary_unverified/);
  assert.match(releaseGates, /windows_user_setup_guidance_captures_password/);
  assert.match(releaseGates, /windows_user_setup_guidance_sequence_mismatch/);
  assert.match(releaseGates, /windows_user_setup_guidance_checklist_order_mismatch/);
  assert.match(releaseGates, /windows_user_setup_guidance_checklist_real_traffic/);
  assert.match(releaseGates, /windows_user_setup_guidance_setup_plan_missing/);
  assert.match(releaseGates, /windows_user_setup_guidance_setup_plan_raw_command/);
  assert.match(releaseGates, /windows_user_setup_guidance_setup_plan_entrypoint/);
  assert.match(releaseGates, /account_isolation_status_release_proof_claimed/);
  assert.match(releaseGates, /account_isolation_status_final_proof_plan_missing/);
  assert.match(releaseGates, /account_isolation_status_final_proof_requires_credential_boundary/);
  assert.match(releaseGates, /account_isolation_status_final_proof_requires_interactive_login/);
  assert.match(releaseGates, /account_isolation_status_final_proof_requires_real_traffic/);
  assert.match(releaseGates, /account_isolation_status_final_proof_requires_distinct_identity/);
  assert.match(releaseGates, /account_isolation_status_final_proof_account_ids_must_differ/);
  assert.match(releaseGates, /account_isolation_status_target_sid_matches_current_user/);
  assert.match(releaseGates, /account_isolation_status_identity_boundary_unverified/);
  assert.match(releaseGates, /source_preflight_windows_user_login_runas_workdir_missing/);
  assert.match(releaseGates, /source_preflight_windows_user_login_bootstrap_keeps_shell/);
  assert.match(releaseGates, /secondAccountLoginEntrypoint/);
  assert.match(releaseGates, /requireSecondAccountLoginEntrypointSemantics/);
  assert.match(releaseGates, /second_account_entrypoint_started_login/);
  assert.match(releaseGates, /second_account_entrypoint_changed_system/);
  assert.match(releaseGates, /second_account_entrypoint_created_user/);
  assert.match(releaseGates, /second_account_entrypoint_captures_password/);
  assert.match(releaseGates, /second_account_entrypoint_stores_password/);
  assert.match(releaseGates, /second_account_entrypoint_release_proof_claimed/);
  assert.match(releaseGates, /post_login_proof_command_windows_user/);
  assert.match(goalReadiness, /postLoginProofCommandTemplate[\s\S]*-WindowsUser/);
  assert.match(managerBridge, /antigravityCliWindowsUserReadiness/);
  assert.match(managerBridge, /runasWorkdir/);
  assert.match(managerBridge, /bootstrapKeepsShell/);
  assert.match(managerBridge, /windowsUserAccountPrepare/);
  assert.match(managerBridge, /safeToAskLogin/);
  assert.match(managerBridge, /canProceedLogin/);
  assert.match(managerBridge, /windowsUserSetupGuidance/);
  assert.match(managerBridge, /readinessCheckSequence/);
  assert.match(managerBridge, /operatorChecklistStages/);
  assert.match(managerBridge, /operatorSetupPlan/);
  assert.match(managerBridge, /rawUserManagementCommandProvided/);
  assert.match(managerBridge, /secondAccountLoginEntrypoint/);
  assert.match(managerBridge, /secondAccountLoginEntrypoint loginCommand/);
  assert.match(managerBridge, /secondAccountLoginEntrypoint proofCommand/);
  assert.match(managerBridge, /secondAccountReadinessSummary/);
  assert.match(managerBridge, /secondAccountReadinessSummary next/);
  assert.match(managerBridge, /secondAccountReadinessSummary checklist/);
  assert.match(managerBridge, /secondAccountReadinessSummary hint/);
  assert.match(managerBridge, /secondAccountReadinessSummary caveat/);
  assert.match(managerInject, /antigravityCliWindowsUserReadiness/);
  assert.match(managerInject, /windowsUserAccountPrepare/);
  assert.match(managerInject, /safeToAskLogin/);
  assert.match(managerInject, /canProceedLogin/);
  assert.match(managerInject, /windowsUserSetupGuidance/);
  assert.match(managerInject, /readinessCheckSequence/);
  assert.match(managerInject, /operatorChecklistStages/);
  assert.match(managerInject, /operatorSetupPlan/);
  assert.match(managerInject, /rawUserManagementCommandProvided/);
  assert.match(managerInject, /secondAccountLoginEntrypoint/);
  assert.match(managerInject, /secondAccountLoginEntrypoint loginCommand/);
  assert.match(managerInject, /secondAccountLoginEntrypoint proofCommand/);
  assert.match(managerInject, /secondAccountReadinessSummary/);
  assert.match(managerInject, /secondAccountReadinessSummary next/);
  assert.match(managerInject, /secondAccountReadinessSummary checklist/);
  assert.match(managerInject, /secondAccountReadinessSummary hint/);
  assert.match(managerInject, /secondAccountReadinessSummary caveat/);
  assert.match(server, /latest-antigravity-cli-windows-user-readiness\.json/);
  assert.match(server, /antigravityCliWindowsUserReadiness/);
  assert.match(server, /runasWorkingDirectory/);
  assert.match(server, /bootstrapKeepsShellOpen/);
  assert.match(server, /currentWindowsUserSidPresent/);
  assert.match(server, /targetWindowsUserSidPresent/);
  assert.match(server, /targetUserIdentityBoundaryOk/);
  assert.match(server, /runasWorkdir/);
  assert.match(server, /latest-windows-user-account-prepare\.json/);
  assert.match(server, /windowsUserAccountPrepare/);
  assert.match(server, /safeToAskLogin/);
  assert.match(server, /canProceedLogin/);
  assert.match(server, /latest-windows-user-setup-guidance\.json/);
  assert.match(server, /secondAccountLoginEntrypointEvidence/);
  assert.match(server, /secondAccountLoginEntrypoint loginCommand/);
  assert.match(server, /secondAccountLoginEntrypoint proofCommand/);
  assert.match(server, /secondAccountReadinessSummaryEvidence/);
  assert.match(server, /secondAccountReadinessSummary next/);
  assert.match(server, /secondAccountReadinessSummary checklist/);
  assert.match(server, /secondAccountReadinessSummary hint/);
  assert.match(server, /secondAccountReadinessSummary caveat/);
  assert.match(server, /windowsUserSetupGuidance/);
  assert.match(server, /windowsUserSetupGuidanceEvidence/);
  assert.match(server, /readinessCheckSequence/);
  assert.match(server, /operatorChecklistStages/);
  assert.match(server, /operatorSetupPlan/);
  assert.match(server, /rawUserManagementCommandProvided/);
});

test("approved real run sequence is a no-traffic gate before concrete task execution", () => {
  const verifier = readFileSync(resolve(root, "scripts", "test-anticodex-approved-real-run-sequence.mjs"), "utf8");
  const summarizer = readFileSync(resolve(root, "scripts", "summarize-anticodex-report.mjs"), "utf8");
  const collector = readFileSync(resolve(root, "scripts", "collect-anticodex-diagnostics.ps1"), "utf8");
  const diagnostics = readFileSync(resolve(root, "scripts", "test-anticodex-diagnostics.ps1"), "utf8");
  const runtimeSync = readFileSync(resolve(root, "scripts", "sync-anticodex-runtime.ps1"), "utf8");
  const installedOverall = readFileSync(resolve(root, "scripts", "test-anticodex-installed-overall.ps1"), "utf8");
  const signer = readFileSync(resolve(root, "scripts", "sign-anticodex-reports.mjs"), "utf8");
  const releaseGates = readFileSync(resolve(root, "scripts", "test-anticodex-release-gates.mjs"), "utf8");
  const server = readFileSync(resolve(root, "translator", "adaptive-server.mjs"), "utf8");
  const managerBridge = readFileSync(resolve(root, "scripts", "anticodex-manager-bridge.mjs"), "utf8");
  const managerInject = readFileSync(resolve(root, "scripts", "anticodex-manager-inject.js"), "utf8");

  assert.match(verifier, /reportName:\s*"approved-real-run-sequence"/);
  assert.match(verifier, /requestedRealTraffic:\s*false/);
  assert.match(verifier, /usedRealTraffic:\s*false/);
  assert.match(verifier, /coverageKind:\s*"approved-real-run-sequence-report-only"/);
  assert.match(verifier, /executionBlockedBeforeRealTraffic/);
  assert.match(verifier, /readyToRequestUserApproval:\s*false/);
  assert.match(verifier, /latest-goal-real-run-readiness\.json/);
  assert.match(verifier, /latest-real-approval-plan\.json/);
  assert.match(verifier, /latest-required-real-traffic-sequence\.json/);
  assert.match(verifier, /latest-antigravity-account-isolation-status\.json/);
  assert.match(verifier, /web-search/);
  assert.match(verifier, /free-chat/);
  assert.match(verifier, /accountProxyReadiness/);
  assert.match(verifier, /postVerification/);
  assert.match(verifier, /StartLoginApproval start-separate-windows-user-login/);
  assert.match(verifier, /latest-second-antigravity-account-login-entrypoint\.json/);
  assert.match(verifier, /login_command_missing_windows_user/);
  assert.match(verifier, /account_proof_command_missing_separate_account_flag/);
  assert.match(verifier, /SeparateAccountProofApprovalId/);
  assert.doesNotMatch(verifier, /spawn\(|spawnSync\(|exec\(|execSync\(/);
  assert.doesNotMatch(verifier, /["']\.env["']/);

  for (const surface of [collector, diagnostics, installedOverall, signer, releaseGates, server]) {
    assert.match(surface, /latest-approved-real-run-sequence\.json/);
  }
  assert.match(runtimeSync, /test-anticodex-approved-real-run-sequence\.mjs/);
  assert.match(summarizer, /reportName === "approved-real-run-sequence"/);
  assert.match(summarizer, /approvedRealRunSequenceEvidence/);
  assert.match(collector, /approvedRealRunSequenceEvidence/);
  assert.match(diagnostics, /Test-ApprovedRealRunSequenceSummaryEvidence/);
  assert.match(releaseGates, /approvedRealRunSequence/);
  assert.match(releaseGates, /requireApprovedRealRunSequenceSemantics/);
  assert.match(releaseGates, /approved_real_run_sequence_login_stage_contract/);
  assert.match(releaseGates, /approved_real_run_sequence_second_account_entrypoint_source_missing/);
  assert.match(releaseGates, /approved_real_run_sequence_login_command_not_isolated/);
  assert.match(releaseGates, /approved_real_run_sequence_account_proof_command_incomplete/);
  assert.match(releaseGates, /test-anticodex-approved-real-run-sequence\.mjs/);
  assert.match(server, /Approved real run sequence/);
  assert.match(managerBridge, /approvedRealRun: blocked=/);
  assert.match(managerBridge, /approvedRealRun tasks:/);
  assert.match(managerInject, /approvedRealRun: blocked=/);
  assert.match(managerInject, /approvedRealRun tasks:/);
});
