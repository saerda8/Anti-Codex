import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import {
  createAntigravityCascadeClient,
  discoverAntigravityDesktopConnection,
} from "../translator/provider/antigravity-cascade-client.mjs";

const SEALED = /^dpapi:v1:[A-Za-z0-9+/]+={0,2}$/;
const ACCOUNT_ID = /^sha256:[a-f0-9]{64}$/;
const HASH = /^[a-f0-9]{64}$/;
const SENSITIVE_FIELD = /(?:auth|credential|secret|token|key)/i;
const MAX_OUTPUT_BYTES = 1024 * 1024;

function parseJson(value) {
  if (value && typeof value === "object") return value;
  return JSON.parse(String(value || ""));
}

function safeUsageValue(value) {
  if (Array.isArray(value)) return value.map(safeUsageValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !SENSITIVE_FIELD.test(key))
    .map(([key, item]) => [key, safeUsageValue(item)]));
}

function defaultRunner(env) {
  return (request) => new Promise((resolvePromise, rejectPromise) => {
    const powershell = join(
      env.SystemRoot || process.env.SystemRoot || "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    const file = request.kind === "usage" ? request.file : powershell;
    const args = request.kind === "usage"
      ? request.args
      : request.kind === "open"
        ? ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", request.script]
        : ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", request.script, "-Action", request.action];
    const child = spawn(file, args, {
      env: { ...process.env, ...env },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const chunks = [];
    let length = 0;
    let settled = false;
    const finish = (error, output = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) rejectPromise(error);
      else resolvePromise(output);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error("process timeout"));
    }, request.kind === "usage" ? 35_000 : 180_000);
    child.stdout.on("data", (chunk) => {
      length += chunk.length;
      if (length > MAX_OUTPUT_BYTES) {
        child.kill();
        finish(new Error("process output too large"));
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.resume();
    child.stdin.on("error", (error) => finish(error));
    child.stdout.on("error", (error) => finish(error));
    child.once("error", (error) => finish(error));
    child.once("close", (code) => finish(code === 0 ? null : new Error("process failed"), Buffer.concat(chunks).toString("utf8")));
    child.stdin.end(request.kind === "powershell" ? JSON.stringify(request.input || {}) : String(request.input || ""));
  });
}

export function createAntigravityAccountDriver(options = {}) {
  const scriptsRoot = resolve(String(options.scriptsRoot || "").trim());
  const env = options.env || process.env;
  if (!String(options.scriptsRoot || "").trim()) throw new TypeError("scriptsRoot is required.");
  if (!env.LOCALAPPDATA) throw new TypeError("LOCALAPPDATA is required.");
  const runner = options.runner || defaultRunner(env);
  const findDesktopConnection = options.findDesktopConnection
    || (() => discoverAntigravityDesktopConnection(env, { processOnly: true }));
  const fetchImpl = options.fetchImpl || fetch;
  const desktopClient = options.desktopClient || createAntigravityCascadeClient({
    env,
    fetchImpl,
    discoverConnection: findDesktopConnection,
    statusTimeoutMs: 10_000,
  });
  const script = join(scriptsRoot, "anticodex-antigravity-credentials.ps1");
  const openScript = join(scriptsRoot, "open-antigravity-account-switch.ps1");

  const runPowerShell = (action, input) => runner({ kind: "powershell", action, script, input });

  async function hasCredential() {
    try {
      const value = parseJson(await runPowerShell("HasCredential", {}));
      if (typeof value?.exists !== "boolean") throw new Error("invalid credential status");
      return value.exists;
    } catch {
      throw new Error("Antigravity credential status check failed.");
    }
  }

  async function capture() {
    try {
      const value = parseJson(await runPowerShell("Capture", {}));
      const result = {
        id: String(value.id || "").toLowerCase(),
        maskedEmail: String(value.maskedEmail || ""),
        sealed: String(value.sealed || ""),
        credentialHash: String(value.credentialHash || "").toLowerCase(),
      };
      if (!ACCOUNT_ID.test(result.id) || !result.maskedEmail || !SEALED.test(result.sealed) || !HASH.test(result.credentialHash)) {
        throw new Error("invalid capture");
      }
      return result;
    } catch {
      throw new Error("Antigravity credential capture failed.");
    }
  }

  async function restore(sealed) {
    if (!SEALED.test(String(sealed || ""))) throw new Error("Antigravity sealed credential is invalid.");
    try {
      const value = parseJson(await runPowerShell("Restore", { sealed }));
      if (value?.ok !== true) throw new Error("restore rejected");
    } catch {
      throw new Error("Antigravity credential restore failed.");
    }
  }

  async function quota() {
    try {
      const file = join(env.LOCALAPPDATA, "agy", "bin", "agy.exe");
      const args = ["-p", "/usage", "--output-format", "json", "--print-timeout", "30s"];
      const value = parseJson(await runner({ kind: "usage", file, args, input: "" }));
      if (value?.status !== "SUCCESS"
        || value?.num_turns !== 0
        || value?.command?.name !== "usage"
        || !Array.isArray(value?.command?.data?.groups)) {
        throw new Error("invalid usage response");
      }
      return {
        status: "SUCCESS",
        num_turns: 0,
        command: {
          name: "usage",
          data: { groups: safeUsageValue(value.command.data.groups) },
        },
      };
    } catch {
      throw new Error("Antigravity usage query failed.");
    }
  }

  async function beginChange({ acknowledgeRestart = false } = {}) {
    if (acknowledgeRestart !== true) throw new Error("Antigravity restart acknowledgement is required.");
    try {
      const value = parseJson(await runPowerShell("PauseDesktop", { acknowledgeRestart: true }));
      if (typeof value?.wasRunning !== "boolean") throw new Error("invalid pause result");
      return { wasRunning: value.wasRunning };
    } catch {
      throw new Error("Antigravity Desktop pause failed.");
    }
  }

  async function endChange(context) {
    if (!context || typeof context.wasRunning !== "boolean" || Object.keys(context).length !== 1) {
      throw new Error("Antigravity change context is invalid.");
    }
    try {
      const value = parseJson(await runPowerShell("ResumeDesktop", { wasRunning: context.wasRunning }));
      if (value?.ok !== true) throw new Error("invalid resume result");
    } catch {
      const error = new Error("Antigravity Desktop resume failed; its state needs to be checked before restoring credentials.");
      error.credentialRestoreUnsafe = true;
      throw error;
    }
  }

  async function openDesktop() {
    try {
      const value = parseJson(await runner({ kind: "open", script: openScript, input: "" }));
      if (value?.ok !== true) throw new Error("open rejected");
    } catch {
      const error = new Error("Antigravity Desktop could not be opened or focused.");
      error.credentialRestoreUnsafe = true;
      throw error;
    }
  }

  async function hasDesktop() {
    try {
      const value = parseJson(await runPowerShell("HasDesktop", {}));
      if (typeof value?.running !== "boolean") throw new Error("invalid Desktop status");
      return value.running;
    } catch {
      throw new Error("Antigravity Desktop status check failed.");
    }
  }

  async function desktopIdentity() {
    try {
      const readiness = await desktopClient.getReadiness();
      const id = String(readiness?.accountFingerprint || "").toLowerCase();
      if (readiness?.signedIn !== true || !ACCOUNT_ID.test(id)) throw new Error("identity unavailable");
      return id;
    } catch {
      const error = new Error("Antigravity Desktop account identity could not be verified.");
      error.credentialRestoreUnsafe = true;
      throw error;
    }
  }

  const driver = { hasCredential, capture, restore, quota, beginChange, endChange, openDesktop, hasDesktop, desktopIdentity };
  if (typeof options.login === "function") {
    driver.login = async ({ acknowledgeRestart = false } = {}) => {
      if (acknowledgeRestart !== true) throw new Error("Antigravity restart acknowledgement is required.");
      try { await options.login({ acknowledgeRestart: true }); } catch (cause) {
        const error = new Error("Antigravity official login failed.");
        if (cause?.credentialRestoreUnsafe) error.credentialRestoreUnsafe = true;
        throw error;
      }
    };
  }
  if (typeof options.cancelLogin === "function") {
    driver.cancelLogin = async () => {
      try { await options.cancelLogin(); } catch (cause) {
        const error = new Error("Antigravity official login cleanup failed.");
        if (cause?.credentialRestoreUnsafe) error.credentialRestoreUnsafe = true;
        throw error;
      }
    };
  }
  return driver;
}
