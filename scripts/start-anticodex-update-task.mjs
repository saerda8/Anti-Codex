import { spawnSync } from "node:child_process";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const localAppData = String(process.env.LOCALAPPDATA || "").trim();
const appData = String(process.env.APPDATA || "").trim();
const installRoot = resolve(scriptRoot, "..", "..");
const expectedRoot = localAppData ? resolve(localAppData, "Anti-Codex") : "";
const windowsRoot = String(process.env.SystemRoot || process.env.WINDIR || "C:\\Windows");
const powershell = join(windowsRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const syncLauncher = join(scriptRoot, "sync-anticodex-launcher.ps1");
const updateStatusModule = join(scriptRoot, "anticodex-update-status.psm1");
const hideConsole = join(scriptRoot, "hide-anticodex-console.ps1");
const logRoot = appData ? join(appData, "anticodex", "logs") : "";
const outLog = logRoot ? join(logRoot, "anticodex-updater.out.log") : "";
const errLog = logRoot ? join(logRoot, "anticodex-updater.err.log") : "";
let statusWritesSafe = false;

function quotePowerShellLiteral(value) {
  return `'${String(value ?? "").replaceAll("'", "''")}'`;
}

function bestEffortAppend(path, message) {
  if (!path) return;
  try {
    appendFileSync(path, message, "utf8");
  } catch {}
}

function markUpdaterHandoffFailed(message) {
  if (!statusWritesSafe) return false;
  try {
    const command = [
      '$ErrorActionPreference = "Stop"',
      `Import-Module ${quotePowerShellLiteral(updateStatusModule)} -Force`,
      `[void](Set-AntiCodexUpdateOperation -State "failed" -Stage "updater_handoff_failed" -Message ${quotePowerShellLiteral(message)} -FailureCode "updater_handoff_failed" -ExpectedStates @("running") -ExpectedStages @("updater_queued", "updater_handoff"))`,
    ].join("\r\n");
    const statusResult = spawnSync(powershell, [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy", "Bypass",
      "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64"),
    ], {
      cwd: installRoot,
      env: process.env,
      windowsHide: true,
      timeout: 10_000,
      encoding: "utf8",
    });
    if (statusResult.error || statusResult.status !== 0) {
      bestEffortAppend(errLog, `${new Date().toISOString()} updater status write failed: ${statusResult.error?.message || statusResult.stderr || statusResult.status}\n`);
      return false;
    }
    return true;
  } catch (error) {
    bestEffortAppend(errLog, `${new Date().toISOString()} updater status write failed: ${error?.message || error}\n`);
    return false;
  }
}

let stdout = null;
let stderr = null;
let exitCode = 1;
try {
  if (process.platform !== "win32" || !localAppData || !appData) {
    throw new Error("Anti-Codex updater task requires the current Windows user environment.");
  }
  if (installRoot.toLowerCase() !== expectedRoot.toLowerCase()) {
    throw new Error(`Anti-Codex updater task may only run from ${expectedRoot}`);
  }
  for (const requiredPath of [powershell, updateStatusModule]) {
    if (!existsSync(requiredPath)) throw new Error(`Anti-Codex updater component is missing: ${requiredPath}`);
  }
  statusWritesSafe = true;
  if (!existsSync(syncLauncher)) {
    throw new Error(`Anti-Codex updater component is missing: ${syncLauncher}`);
  }

  mkdirSync(logRoot, { recursive: true });
  const stamp = new Date().toISOString();
  appendFileSync(outLog, `${stamp} updater task broker started\n`, "utf8");

  if (process.argv.includes("--hide-console") && existsSync(hideConsole)) {
    const hidden = spawnSync(powershell, [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy", "Bypass",
      "-WindowStyle", "Hidden",
      "-File", hideConsole,
      "-TargetProcessId", String(process.pid),
    ], { windowsHide: true, timeout: 5_000, encoding: "utf8" });
    if (hidden.error || hidden.status !== 0) {
      bestEffortAppend(errLog, `${stamp} console hide failed: ${hidden.error?.message || hidden.stderr || hidden.status}\n`);
    }
  }

  stdout = openSync(outLog, "a");
  stderr = openSync(errLog, "a");
  const result = spawnSync(powershell, [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-WindowStyle", "Hidden",
    "-File", syncLauncher,
    "-FromUpdateTask",
  ], {
    cwd: installRoot,
    env: process.env,
    stdio: ["ignore", stdout, stderr],
    windowsHide: true,
  });
  if (result.error) throw result.error;

  exitCode = Number.isInteger(result.status) ? result.status : 1;
  if (exitCode !== 0) {
    const failure = new Error(`Updater launcher exited with code ${exitCode}.`);
    failure.exitCode = exitCode;
    throw failure;
  }
  bestEffortAppend(outLog, `${new Date().toISOString()} updater task broker exited with code ${exitCode}\n`);
} catch (error) {
  markUpdaterHandoffFailed(error?.message || String(error));
  bestEffortAppend(errLog, `${new Date().toISOString()} updater task broker failed: ${error?.message || error}\n`);
  const reportedExitCode = Number(error?.exitCode);
  exitCode = Number.isInteger(reportedExitCode) && reportedExitCode !== 0 ? reportedExitCode : 1;
} finally {
  if (stdout !== null) {
    try { closeSync(stdout); } catch {}
  }
  if (stderr !== null) {
    try { closeSync(stderr); } catch {}
  }
  process.exitCode = exitCode;
}
