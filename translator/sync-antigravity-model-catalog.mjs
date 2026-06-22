#!/usr/bin/env node

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { mkdirSync } from "node:fs";

import { fetchAvailableAgentModels } from "./antigravity-agentapi.mjs";
import {
  buildAntigravityModelCatalog,
  extractAvailableAgentModels,
} from "./antigravity-model-catalog.mjs";

const [basePathArg, outputPathArg] = process.argv.slice(2);
if (!basePathArg || !outputPathArg) {
  throw new Error("Usage: sync-antigravity-model-catalog.mjs <base-catalog> <output-catalog>");
}

const basePath = resolve(basePathArg);
const outputPath = resolve(outputPathArg);
const baseCatalog = JSON.parse(readFileSync(basePath, "utf8").replace(/^\uFEFF/, ""));

let payload;
let lastError;
const attempts = positiveInteger(process.env.ANTIGRAVITY_MODEL_DISCOVERY_ATTEMPTS, 6);
const timeoutMs = positiveInteger(process.env.ANTIGRAVITY_MODEL_DISCOVERY_TIMEOUT_MS, 3000);
const retryDelayMs = positiveInteger(process.env.ANTIGRAVITY_MODEL_DISCOVERY_RETRY_DELAY_MS, 750);
for (let attempt = 0; attempt < attempts; attempt += 1) {
  try {
    payload = await fetchAvailableAgentModels({ timeoutMs });
    break;
  } catch (error) {
    lastError = error;
    if (attempt < attempts - 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, retryDelayMs));
    }
  }
}
if (!payload) throw lastError ?? new Error("Antigravity model discovery failed.");

const availableModels = extractAvailableAgentModels(payload);
if (!availableModels.length) throw new Error("Antigravity returned an empty model list.");

const catalog = buildAntigravityModelCatalog(baseCatalog, availableModels);
mkdirSync(dirname(outputPath), { recursive: true });
const temporaryPath = `${outputPath}.${process.pid}.tmp`;
writeFileSync(temporaryPath, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
renameSync(temporaryPath, outputPath);
console.log(`ANTIGRAVITY_MODELS=${availableModels.length}`);

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
