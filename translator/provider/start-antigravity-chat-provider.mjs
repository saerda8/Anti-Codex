import { pathToFileURL } from "node:url";

import { createAntigravityCascadeClient } from "./antigravity-cascade-client.mjs";
import { createAntigravityChatAdapter } from "./antigravity-chat-adapter.mjs";
import { createAntigravityChatServer } from "./antigravity-chat-server.mjs";

export async function startAntigravityChatProvider(options = {}) {
  const client = options.client ?? createAntigravityCascadeClient(options.clientOptions);
  const adapter = options.adapter ?? createAntigravityChatAdapter({
    client,
    ...(options.adapterOptions ?? {}),
  });
  const server = await createAntigravityChatServer({
    adapter,
    host: options.host ?? "127.0.0.1",
    port: options.port ?? 0,
    authToken: options.authToken,
    maxBodyBytes: options.maxBodyBytes,
  });
  return { ...server, client, adapter };
}

async function main() {
  const provider = await startAntigravityChatProvider({
    host: process.env.ANTICODEX_ANTIGRAVITY_ADAPTER_HOST ?? "127.0.0.1",
    port: Number(process.env.ANTICODEX_ANTIGRAVITY_ADAPTER_PORT ?? 0),
  });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: "anticodex.antigravity_chat_adapter.ready",
    url: provider.url,
    pid: process.pid,
  })}\n`);
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await provider.close();
  };
  process.once("SIGINT", () => void close().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void close().finally(() => process.exit(0)));
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exitCode = 1;
  });
}
