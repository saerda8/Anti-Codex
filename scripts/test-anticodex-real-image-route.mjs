#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const scriptRoot = resolve(fileURLToPath(new URL(".", import.meta.url)));
const sourceRoot = resolve(scriptRoot, "..");

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--help" || key === "-h") values.set("--help", true);
    else if (key === "--allow-real-traffic") values.set(key, true);
    else if (key.startsWith("--")) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${key}`);
      values.set(key, value);
      index += 1;
    } else throw new Error(`Unexpected argument: ${key}`);
  }
  return values;
}

function mimeTypeFor(path) {
  const extension = extname(path).toLowerCase();
  const mime = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" }[extension];
  if (!mime) throw new Error(`Unsupported image extension: ${extension || "missing"}`);
  return mime;
}

function loopbackBaseUrl(raw) {
  const url = new URL(raw);
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(host)) {
    throw new Error("--base-url must be an HTTP loopback URL");
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

function output(payload, exitCode = 0) {
  console.log(JSON.stringify(payload, null, 2));
  if (exitCode) process.exitCode = exitCode;
}

function responseText(payload) {
  const outputItems = Array.isArray(payload?.output) ? payload.output : [];
  return outputItems.flatMap((item) => Array.isArray(item?.content) ? item.content : [])
    .map((part) => String(part?.text ?? ""))
    .join("") || String(payload?.output_text ?? "");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.has("--help")) {
    console.log("Usage: node scripts/test-anticodex-real-image-route.mjs --allow-real-traffic [--model <id>] [--base-url <url>] [--image <path> --question <text> --expected-json <json>] [--auth-file <path>] [--timeout-ms <n>]");
    return;
  }
  if (!args.has("--allow-real-traffic")) {
    output({
      ok: true,
      skipped: true,
      requestedRealTraffic: false,
      usedRealTraffic: false,
      coverageKind: "skipped-no-real-traffic",
      reason: "Rerun with --allow-real-traffic to send one loopback image request.",
      uiUploadVerified: false,
    });
    return;
  }

  const baseUrl = loopbackBaseUrl(String(args.get("--base-url") || "http://127.0.0.1:18484/v1"));
  const model = String(args.get("--model") || "claude-sonnet-4-6");
  const imagePath = resolve(args.get("--image") || resolve(sourceRoot, "assets", "vision-smoke.png"));
  if (args.has("--image") && (!args.has("--question") || !args.has("--expected-json"))) {
    throw new Error("Custom images require --question and --expected-json so recognition is actually checked.");
  }
  const question = String(args.get("--question") || "Read the printed code and count the colored shapes in the attached image. Return only JSON with keys code, red_circles, blue_squares, green_triangles. Do not use tools or guess if the image is unavailable.");
  const expected = args.has("--expected-json") ? JSON.parse(args.get("--expected-json")) : {
    code: "CEDAR 4827", red_circles: 2, blue_squares: 1, green_triangles: 3,
  };
  const authFile = resolve(args.get("--auth-file") || resolve(
    process.env.APPDATA || ".",
    "anticodex",
    "codex-home-deepseek-app",
    "auth.json",
  ));
  const timeoutMs = Math.max(5_000, Number(args.get("--timeout-ms") || 120_000));
  const mimeType = mimeTypeFor(imagePath);
  const imageBytes = readFileSync(imagePath);
  const auth = JSON.parse(readFileSync(authFile, "utf8"));
  const token = String(auth.OPENAI_API_KEY || "");
  if (!token) throw new Error(`Missing OPENAI_API_KEY in ${authFile}`);

  const headers = { authorization: `Bearer ${token}` };
  const modelsResponse = await fetch(`${baseUrl}/models`, {
    headers,
    signal: AbortSignal.timeout(Math.min(timeoutMs, 15_000)),
  });
  const modelsPayload = await modelsResponse.json().catch(() => ({}));
  const modelAvailable = Array.isArray(modelsPayload?.data)
    && modelsPayload.data.some((entry) => String(entry?.id || "") === model);
  if (!modelsResponse.ok || !modelAvailable) {
    output({
      ok: false,
      requestedRealTraffic: true,
      usedRealTraffic: false,
      coverageKind: "fixed-route-model-preflight",
      fixedRoute: { baseUrl, modelsStatus: modelsResponse.status, model, modelAvailable },
      image: { path: imagePath, bytes: imageBytes.length, mimeType },
      uiUploadVerified: false,
    }, 1);
    return;
  }

  const requestBody = {
    model,
    stream: false,
    input: [{
      role: "user",
      content: [
        { type: "input_text", text: question },
        { type: "input_image", image_url: `data:${mimeType};base64,${imageBytes.toString("base64")}` },
      ],
    }],
  };
  const response = await fetch(`${baseUrl}/responses`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(requestBody),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = await response.json().catch(() => ({}));
  const text = responseText(payload);
  let recognized = null;
  try { recognized = JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")); } catch {}
  const recognitionMatched = isDeepStrictEqual(recognized, expected);
  const ok = response.ok && recognitionMatched;
  output({
    ok,
    requestedRealTraffic: true,
    usedRealTraffic: true,
    coverageKind: "fixed-route-responses-image-recognition",
    fixedRoute: { baseUrl, modelsStatus: modelsResponse.status, model, modelAvailable, responseStatus: response.status },
    image: { path: imagePath, bytes: imageBytes.length, mimeType, requestPartType: "input_image" },
    response: { id: payload?.id || "", model: payload?.model || "", recognitionMatched, recognized, text: text.slice(0, 500) },
    uiUploadVerified: false,
    uiUploadReason: "Direct loopback HTTP request intentionally bypasses the desktop file picker.",
  }, ok ? 0 : 1);
}

main().catch((error) => {
  output({ ok: false, requestedRealTraffic: true, usedRealTraffic: false, error: error?.message || String(error), uiUploadVerified: false }, 1);
});
