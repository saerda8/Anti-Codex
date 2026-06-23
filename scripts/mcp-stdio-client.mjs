import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === "function") timer.unref();
  });
}

export async function runMcpStdioList(options = {}) {
  return runMcpStdioExchange({ ...options, listOnly: true });
}

export async function runMcpStdioCall(options = {}) {
  return runMcpStdioExchange(options);
}

async function runMcpStdioExchange({
  command,
  args = [],
  env = {},
  cwd,
  toolName,
  arguments: toolArguments = {},
  timeoutMs = 5000,
  listOnly = false,
} = {}) {
  if (!command) throw new Error("MCP stdio command is required.");
  if (!listOnly && !toolName) throw new Error("MCP tool name is required.");

  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const stdout = createInterface({ input: child.stdout });
  const stderrLines = [];
  const pending = new Map();
  const deadline = Date.now() + Math.max(1, Number(timeoutMs) || 5000);
  let nextId = 1;
  let terminalError = null;

  const rejectPending = (error) => {
    terminalError ||= error;
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  };

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => stderrLines.push(String(chunk)));
  child.once("error", (error) => rejectPending(error));
  child.once("exit", (code, signal) => {
    if (pending.size > 0) {
      rejectPending(new Error(`MCP stdio server exited before replying (code=${code}, signal=${signal || "none"}).`));
    }
  });
  stdout.on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message?.id === undefined || message?.id === null) return;
    const entry = pending.get(String(message.id));
    if (!entry) return;
    pending.delete(String(message.id));
    clearTimeout(entry.timer);
    if (message.error) {
      entry.reject(new Error(`MCP ${entry.method} failed: ${message.error.message || JSON.stringify(message.error)}`));
    } else {
      entry.resolve(message.result ?? null);
    }
  });

  const writeMessage = (message) => {
    if (terminalError) throw terminalError;
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };

  const request = (method, params = {}) => {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return Promise.reject(new Error(`MCP stdio call timed out before ${method}.`));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(String(id));
        reject(new Error(`MCP ${method} timed out after ${timeoutMs} ms.`));
      }, remainingMs);
      pending.set(String(id), { method, resolve, reject, timer });
      try {
        writeMessage({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        clearTimeout(timer);
        pending.delete(String(id));
        reject(error);
      }
    });
  };

  try {
    const initialized = await request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "anticodex-mcp-smoke", version: "1.0.0" },
    });
    writeMessage({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
    const listed = await request("tools/list", {});
    const tools = Array.isArray(listed?.tools) ? listed.tools : [];
    if (listOnly) {
      return {
        serverInfo: initialized?.serverInfo || null,
        capabilities: initialized?.capabilities || null,
        tools,
        content: [],
        structuredContent: null,
        isError: false,
        stderr: stderrLines.join("").trim(),
      };
    }
    if (!tools.some((tool) => tool?.name === toolName)) {
      throw new Error(`MCP tool '${toolName}' was not returned by tools/list.`);
    }
    const called = await request("tools/call", {
      name: toolName,
      arguments: toolArguments,
    });
    if (called?.isError === true) {
      const text = Array.isArray(called?.content)
        ? called.content.map((item) => typeof item?.text === "string" ? item.text : JSON.stringify(item)).join("\n")
        : "";
      throw new Error(`MCP tool '${toolName}' returned isError=true${text ? `: ${text}` : ""}.`);
    }
    return {
      serverInfo: initialized?.serverInfo || null,
      capabilities: initialized?.capabilities || null,
      tools,
      content: Array.isArray(called?.content) ? called.content : [],
      structuredContent: called?.structuredContent ?? null,
      isError: called?.isError === true,
      stderr: stderrLines.join("").trim(),
    };
  } catch (error) {
    const stderr = stderrLines.join("").trim();
    throw new Error(`${errorMessage(error)}${stderr ? `; stderr: ${stderr}` : ""}`);
  } finally {
    const waitForChildClose = child.exitCode === null && child.signalCode === null;
    stdout.close();
    if (!child.stdin.destroyed) child.stdin.end();
    child.stdout.destroy();
    child.stderr.destroy();
    if (waitForChildClose) child.kill();
    rejectPending(new Error("MCP stdio client closed."));
    if (waitForChildClose) {
      await Promise.race([once(child, "close").catch(() => null), delay(750)]);
    }
  }
}
