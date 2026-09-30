import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runMcpStdioCall, runMcpStdioList } from "../../scripts/mcp-stdio-client.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const serverPath = path.join(repoRoot, "translator", "tools", "web_mcp_stdio.py");
const python = process.env.PYTHON_BIN || (process.platform === "win32" ? "python" : "python3");

function startFixtureServer() {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<html><head><title>Fixture page</title></head><body><h1>Fixture evidence</h1></body></html>");
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ server, url: `http://127.0.0.1:${address.port}/fixture` });
    });
  });
}

test("local web MCP lists both tools and calls web_fetch over stdio", async (t) => {
  const fixture = await startFixtureServer();
  t.after(() => fixture.server.close());

  const listed = await runMcpStdioList({
    command: python,
    args: [serverPath],
    timeoutMs: 8_000,
  });
  assert.deepEqual(
    listed.tools.map((tool) => tool.name).sort(),
    ["web_fetch", "web_search"],
  );

  const called = await runMcpStdioCall({
    command: python,
    args: [serverPath],
    toolName: "web_fetch",
    arguments: { url: fixture.url },
    timeoutMs: 8_000,
  });
  assert.equal(called.isError, false);
  assert.match(called.content.map((item) => item.text || "").join("\n"), /Fixture evidence/);
});
