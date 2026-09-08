import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { discoverAntigravityDesktopConnection } from "../translator/provider/antigravity-cascade-client.mjs";

const execFileAsync = promisify(execFile);

export function createAntigravityOfficialLogin(options = {}) {
  const env = options.env || process.env;
  const launchDesktop = options.launchDesktop || (() => execFileAsync("powershell.exe", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
    join(options.scriptsRoot, "open-antigravity-account-switch.ps1"),
  ], { windowsHide: true, timeout: 60000, maxBuffer: 1024 * 1024, env }));
  const findConnection = options.findConnection || (() => discoverAntigravityDesktopConnection(env, { processOnly: true }));
  const fetchImpl = options.fetchImpl || fetch;
  if (typeof options.stopDesktop !== "function") throw new TypeError("stopDesktop is required.");
  let controller = null;
  let pending = null;

  async function performLogin() {
    const active = controller;
    const timeout = setTimeout(() => active.abort(), 5 * 60 * 1000);
    let failure = null;
    try {
      await launchDesktop();
      const connection = await findConnection();
      if (!/^(?:127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(connection?.lsAddress || "") || !connection?.csrfToken) {
        throw new Error("invalid local connection");
      }
      const response = await fetchImpl(`http://${connection.lsAddress}/exa.language_server_pb.LanguageServerService/Login`, {
        method: "POST",
        headers: { "content-type": "application/json", "connect-protocol-version": "1", "x-codeium-csrf-token": connection.csrfToken },
        body: JSON.stringify({ isGcpTos: false }),
        signal: active.signal,
      });
      if (!response.ok || (await response.json())?.authResult?.hasValidAuth !== true) throw new Error("login incomplete");
    } catch {
      failure = new Error(active.signal.aborted ? "官方登录已取消或超时，请重新添加账号。" : "官方登录未完成，请在 Antigravity 中检查账号验证状态。");
    } finally {
      clearTimeout(timeout);
      try { await options.stopDesktop(); } catch {
        failure = new Error(`${failure?.message || "官方登录已结束。"} 无法停止登录进程，账号状态需要检查。`);
        failure.credentialRestoreUnsafe = true;
      }
      controller = null;
      pending = null;
    }
    if (failure) throw failure;
  }

  return {
    async login({ acknowledgeRestart = false } = {}) {
      if (!acknowledgeRestart) throw new Error("请先确认 Antigravity 重启提示。");
      if (pending) throw new Error("已有官方登录正在进行。");
      controller = new AbortController();
      pending = performLogin();
      return pending;
    },
    async cancelLogin() {
      controller?.abort();
      await pending?.catch((error) => { if (error.credentialRestoreUnsafe) throw error; });
    },
  };
}
