import { execFile } from "node:child_process";
import { basename, join, resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { runMcpStdioCall, runMcpStdioList } from "./mcp-stdio-client.mjs";
import { resolveProductPaths } from "./lib/anticodex-fixed-route.mjs";

const execFileAsync = promisify(execFile);

function contentToText(content, structuredContent) {
  const textParts = [];
  for (const item of Array.isArray(content) ? content : []) {
    if (typeof item?.text === "string") textParts.push(item.text);
    else if (item && typeof item === "object") textParts.push(JSON.stringify(item));
  }
  if (structuredContent !== null && structuredContent !== undefined) {
    textParts.push(typeof structuredContent === "string" ? structuredContent : JSON.stringify(structuredContent));
  }
  return textParts.join("\n");
}

export async function getCodexMcpServerDefinition({
  codexCli,
  codexArgsPrefix = [],
  codexHome,
  serverName = "node_repl",
  timeoutMs = 10000,
} = {}) {
  if (!codexCli) throw new Error("Codex CLI path is required.");
  if (!codexHome) throw new Error("Anti-Codex CODEX_HOME is required.");
  const { stdout } = await execFileAsync(
    codexCli,
    [...codexArgsPrefix, "mcp", "get", serverName, "--json"],
    {
      env: { ...process.env, CODEX_HOME: codexHome },
      timeout: Math.max(1, Number(timeoutMs) || 10000),
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    },
  );
  let definition;
  try {
    definition = JSON.parse(String(stdout || "").trim());
  } catch {
    throw new Error(`Codex returned invalid JSON for MCP server '${serverName}'.`);
  }
  if (definition?.enabled !== true) {
    throw new Error(`Codex MCP server '${serverName}' is not enabled.`);
  }
  if (definition?.transport?.type !== "stdio") {
    throw new Error(`Codex MCP server '${serverName}' is not a stdio server.`);
  }
  if (!definition.transport.command) {
    throw new Error(`Codex MCP server '${serverName}' has no command.`);
  }
  definition.transport.args = Array.isArray(definition.transport.args) ? definition.transport.args : [];
  definition.transport.env = definition.transport.env && typeof definition.transport.env === "object"
    ? definition.transport.env
    : {};
  return definition;
}

export async function runRealMcpSmoke({
  definition,
  productEnvironment = {},
  toolName = "js",
  toolArguments,
  expectedMarker,
  timeoutMs = 10000,
} = {}) {
  if (!definition?.transport?.command) {
    throw new Error("A structured stdio MCP definition is required.");
  }
  if (definition.transport.type !== "stdio") {
    throw new Error(`MCP server '${definition.name || "unknown"}' is not a stdio server.`);
  }
  const startedAt = Date.now();
  const result = await runMcpStdioCall({
    command: definition.transport.command,
    args: Array.isArray(definition.transport.args) ? definition.transport.args : [],
    env: {
      ...productEnvironment,
      ...(definition.transport.env && typeof definition.transport.env === "object" ? definition.transport.env : {}),
    },
    cwd: definition.transport.cwd || undefined,
    toolName,
    arguments: toolArguments ?? {},
    timeoutMs,
  });
  const text = contentToText(result.content, result.structuredContent);
  const markerObserved = expectedMarker ? text.includes(expectedMarker) : null;
  if (expectedMarker && !markerObserved) {
    throw new Error(`MCP tool '${toolName}' completed but did not return expected marker '${expectedMarker}'.`);
  }
  return {
    ok: true,
    serverName: definition.name || "unknown",
    transport: "stdio",
    commandName: basename(definition.transport.command),
    toolName,
    toolCount: result.tools.length,
    markerObserved,
    text,
    serverInfo: result.serverInfo,
    elapsedMs: Date.now() - startedAt,
  };
}

export async function runRealMcpListSmoke({
  definition,
  productEnvironment = {},
  timeoutMs = 10000,
} = {}) {
  if (!definition?.transport?.command) {
    throw new Error("A structured stdio MCP definition is required.");
  }
  if (definition.transport.type !== "stdio") {
    throw new Error(`MCP server '${definition.name || "unknown"}' is not a stdio server.`);
  }
  const startedAt = Date.now();
  const result = await runMcpStdioList({
    command: definition.transport.command,
    args: Array.isArray(definition.transport.args) ? definition.transport.args : [],
    env: {
      ...productEnvironment,
      ...(definition.transport.env && typeof definition.transport.env === "object" ? definition.transport.env : {}),
    },
    cwd: definition.transport.cwd || undefined,
    timeoutMs,
  });
  const toolNames = result.tools
    .map((tool) => String(tool?.name || ""))
    .filter(Boolean)
    .sort();
  return {
    ok: true,
    serverName: definition.name || "unknown",
    transport: "stdio",
    commandName: basename(definition.transport.command),
    toolCount: result.tools.length,
    toolNames,
    serverInfo: result.serverInfo,
    elapsedMs: Date.now() - startedAt,
  };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      options[key] = true;
    } else {
      options[key] = next;
      index += 1;
    }
  }
  return options;
}

function defaultInstallRoot() {
  return join(process.env.LOCALAPPDATA || join(process.env.USERPROFILE || "", "AppData", "Local"), "Anti-Codex");
}

function defaultStateRoot() {
  return join(process.env.APPDATA || join(process.env.USERPROFILE || "", "AppData", "Roaming"), "anticodex");
}

export function buildMcpProductEnvironment({
  installRoot,
  stateRoot,
  codexHome,
  baseEnvironment = process.env,
} = {}) {
  const paths = resolveProductPaths(installRoot, stateRoot);
  const isolatedHome = codexHome || paths.codexHome;
  const helperDirectory = join(isolatedHome, "plugins", ".plugin-appserver");
  const inheritedPath = Object.entries(baseEnvironment)
    .find(([name]) => name.toLowerCase() === "path")?.[1] || "";
  const environment = { ...baseEnvironment };
  for (const name of Object.keys(environment)) {
    if (name.toLowerCase() === "path") delete environment[name];
  }
  return {
    ...environment,
    Path: [helperDirectory, ...String(inheritedPath).split(";").filter(Boolean)]
      .filter((entry, index, entries) => entries.findIndex((item) => item.toLowerCase() === entry.toLowerCase()) === index)
      .join(";"),
    CODEX_HOME: isolatedHome,
    CODEX_HOME_DIR: isolatedHome,
    APPDATA: paths.isolatedAppData,
    LOCALAPPDATA: paths.isolatedLocalAppData,
    TEMP: paths.temp,
    TMP: paths.temp,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const installRoot = resolve(String(args["install-root"] || defaultInstallRoot()));
  const stateRoot = resolve(String(args["state-root"] || defaultStateRoot()));
  const serverName = String(args.server || "node_repl");
  const timeoutMs = Number(args["timeout-ms"] || 15000);
  const reportRoot = resolve(String(args["report-root"] || join(stateRoot, "reports")));
  const codexCli = resolve(String(args["codex-cli"] || join(installRoot, "codex-patched-app", "resources", "codex.exe")));
  const codexHome = resolve(String(args["codex-home"] || join(stateRoot, "codex-home-deepseek-app")));
  const marker = String(args.marker || `ANTICODEX_REAL_MCP_${Date.now()}`);
  const code = String(args.code || `nodeRepl.write("${marker}=42")`);
  const productEnvironment = buildMcpProductEnvironment({ installRoot, stateRoot, codexHome });
  await Promise.all([
    mkdir(productEnvironment.APPDATA, { recursive: true }),
    mkdir(productEnvironment.LOCALAPPDATA, { recursive: true }),
    mkdir(productEnvironment.TEMP, { recursive: true }),
  ]);

  const definition = await getCodexMcpServerDefinition({
    codexCli,
    codexHome,
    serverName,
    timeoutMs,
  });
  const listOnly = args["list-only"] === true || args["list-only"] === "1" || args["list-only"] === "true";
  const report = listOnly
    ? await runRealMcpListSmoke({ definition, productEnvironment, timeoutMs })
    : await runRealMcpSmoke({
        definition,
        productEnvironment,
        toolName: String(args.tool || "js"),
        toolArguments: { code },
        expectedMarker: marker,
        timeoutMs,
      });
  const payload = {
    ...report,
    marker,
    listOnly,
    checkedAt: new Date().toISOString(),
  };
  await mkdir(reportRoot, { recursive: true });
  await writeFile(join(reportRoot, "anticodex-real-mcp-smoke-latest.json"), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await writeFile(join(reportRoot, `anticodex-real-mcp-smoke-${Date.now()}.json`), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
