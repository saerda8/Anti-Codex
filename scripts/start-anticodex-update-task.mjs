import { spawnSync } from "node:child_process";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const localAppData = String(process.env.LOCALAPPDATA || "").trim();
const appData = String(process.env.APPDATA || "").trim();
if (process.platform !== "win32" || !localAppData || !appData) {
  throw new Error("Anti-Codex updater task requires the current Windows user environment.");
}

const installRoot = resolve(scriptRoot, "..", "..");
const expectedRoot = resolve(localAppData, "Anti-Codex");
if (installRoot.toLowerCase() !== expectedRoot.toLowerCase()) {
  throw new Error(`Anti-Codex updater task may only run from ${expectedRoot}`);
}

const windowsRoot = String(process.env.SystemRoot || process.env.WINDIR || "C:\\Windows");
const powershell = join(windowsRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const syncLauncher = join(scriptRoot, "sync-anticodex-launcher.ps1");
const hideConsole = join(scriptRoot, "hide-anticodex-console.ps1");
for (const requiredPath of [powershell, syncLauncher]) {
  if (!existsSync(requiredPath)) throw new Error(`Anti-Codex updater component is missing: ${requiredPath}`);
}

const logRoot = join(appData, "anticodex", "logs");
mkdirSync(logRoot, { recursive: true });
const outLog = join(logRoot, "anticodex-updater.out.log");
const errLog = join(logRoot, "anticodex-updater.err.log");
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
    appendFileSync(errLog, `${stamp} console hide failed: ${hidden.error?.message || hidden.stderr || hidden.status}\n`, "utf8");
  }
}

const stdout = openSync(outLog, "a");
const stderr = openSync(errLog, "a");
let result;
try {
  result = spawnSync(powershell, [
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
} finally {
  closeSync(stdout);
  closeSync(stderr);
}

if (result.error) {
  appendFileSync(errLog, `${new Date().toISOString()} updater task broker failed: ${result.error.message}\n`, "utf8");
  process.exitCode = 1;
} else {
  const exitCode = Number.isInteger(result.status) ? result.status : 1;
  appendFileSync(outLog, `${new Date().toISOString()} updater task broker exited with code ${exitCode}\n`, "utf8");
  process.exitCode = exitCode;
}
