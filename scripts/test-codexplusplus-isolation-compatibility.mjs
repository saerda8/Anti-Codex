#!/usr/bin/env node

import { auditCodexPlusPlusIsolation } from "./lib/codexplusplus-isolation-audit.mjs";

function valueAfter(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

const args = process.argv.slice(2);
const source = valueAfter(args, "--source") ?? process.env.CODEXPLUSPLUS_SOURCE;
const compact = args.includes("--compact");

if (!source) {
  process.stderr.write("缺少 CodexPlusPlus 源码目录，请使用 --source <路径>。\n");
  process.exitCode = 2;
} else {
  try {
    const result = await auditCodexPlusPlusIsolation(source);
    process.stdout.write(`${JSON.stringify(result, null, compact ? 0 : 2)}\n`);
    process.exitCode = result.compatibilityReady ? 0 : 1;
  } catch (error) {
    process.stderr.write(`CodexPlusPlus 隔离审计失败：${error.message}\n`);
    process.exitCode = 2;
  }
}
