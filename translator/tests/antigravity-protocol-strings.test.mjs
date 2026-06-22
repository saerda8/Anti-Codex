import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import {
  extractStrings,
  findTokenWindows,
  buildResult,
  TARGET_TOKENS,
} from "../../scripts/extract-antigravity-protocol-strings.mjs";

// -- Helpers -----------------------------------------------------------

/**
 * Build a synthetic binary buffer where each string is separated by a
 * null byte (mimicking the way strings are laid out in a real binary).
 */
function buildBinary(...strings) {
  const parts = strings.map((s) => Buffer.from(s, "ascii"));
  if (parts.length === 0) return Buffer.alloc(0);
  const chunks = [parts[0]];
  for (let i = 1; i < parts.length; i++) {
    chunks.push(Buffer.from([0x00]));
    chunks.push(parts[i]);
  }
  return Buffer.concat(chunks);
}

// ============================================================================
//  extractStrings
// ============================================================================

test("extractStrings finds printable ASCII runs separated by non-printable bytes", () => {
  const buf = buildBinary("hello", "world", "test");
  const strings = extractStrings(buf);

  assert.equal(strings.length, 3);
  assert.equal(strings[0].value, "hello");
  assert.equal(strings[1].value, "world");
  assert.equal(strings[2].value, "test");
  assert.ok(strings[0].offset < strings[1].offset);
  assert.ok(strings[1].offset < strings[2].offset);
});

test("extractStrings excludes runs shorter than minLength", () => {
  const buf = buildBinary("ab", "hello", "cd");
  const strings = extractStrings(buf, { minLength: 3 });

  assert.equal(strings.length, 1);
  assert.equal(strings[0].value, "hello");
});

test("extractStrings returns empty array for empty buffer", () => {
  assert.equal(extractStrings(Buffer.alloc(0)).length, 0);
});

test("extractStrings returns empty when no run meets minLength", () => {
  const buf = Buffer.from([0x00, 0x01, 0x1f, 0x7f, 0x80, 0xff]);
  assert.equal(extractStrings(buf).length, 0);
});

test("extractStrings captures runs longer than minLength", () => {
  const buf = buildBinary("a", "bcdefgh", "i");
  const strings = extractStrings(buf, { minLength: 5 });

  assert.equal(strings.length, 1);
  assert.equal(strings[0].value, "bcdefgh");
});

// ============================================================================
//  findTokenWindows
// ============================================================================

test("findTokenWindows finds CustomAgentSpec and returns neighbours", () => {
  const buf = buildBinary("prefix_field", "CustomAgentSpec", "name_field", "customTools_field");
  const strings = extractStrings(buf);
  const windows = findTokenWindows(strings, { tokens: TARGET_TOKENS });

  assert.equal(windows.length, 1);
  assert.equal(windows[0].token, "CustomAgentSpec");
  assert.equal(windows[0].string, "CustomAgentSpec");
  assert.deepEqual(windows[0].before, ["prefix_field"]);
  assert.deepEqual(windows[0].after, ["name_field", "customTools_field"]);
});

test("findTokenWindows finds all three target tokens", () => {
  const buf = buildBinary(
    "aaa_SdkCustomizationConfig_bbb",
    "separator",
    "SdkToolOverride",
    "sep2",
    "prefix_CustomAgentSpec",
  );
  const strings = extractStrings(buf);
  const windows = findTokenWindows(strings, { tokens: TARGET_TOKENS });

  const found = new Set(windows.map((w) => w.token));
  assert.ok(found.has("SdkCustomizationConfig"), "missing SdkCustomizationConfig");
  assert.ok(found.has("SdkToolOverride"), "missing SdkToolOverride");
  assert.ok(found.has("CustomAgentSpec"), "missing CustomAgentSpec");
  assert.equal(windows.length, 3);
});

test("findTokenWindows matches substring in compound field names", () => {
  const buf = buildBinary("some_SdkCustomizationConfig_annotated", "next_field");
  const strings = extractStrings(buf);
  const windows = findTokenWindows(strings, { tokens: TARGET_TOKENS });

  assert.equal(windows.length, 1);
  assert.equal(windows[0].token, "SdkCustomizationConfig");
  assert.equal(windows[0].string, "some_SdkCustomizationConfig_annotated");
});

test("findTokenWindows deduplicates identical token+neighbour contexts", () => {
  // Build: pre\x00CustomAgentSpec\x00post\x00pre\x00CustomAgentSpec\x00post
  // With windowSize=1, both matches see before=["pre"] after=["post"] -> same key
  const buf = Buffer.concat([
    Buffer.from("pre\x00CustomAgentSpec\x00post\x00", "ascii"),
    Buffer.from("pre\x00CustomAgentSpec\x00post", "ascii"),
  ]);
  const strings = extractStrings(buf);
  const windows = findTokenWindows(strings, { tokens: TARGET_TOKENS, windowSize: 1 });
  assert.equal(windows.length, 1, "should deduplicate identical contexts");
});

test("findTokenWindows respects windowSize parameter", () => {
  // All strings must be >= minLength(3) to survive extractStrings
  const buf = buildBinary(
    "aaa", "bbb", "ccc", "SdkCustomizationConfig", "ddd", "eee", "fff", "ggg",
  );
  const strings = extractStrings(buf);

  const w2 = findTokenWindows(strings, { tokens: TARGET_TOKENS, windowSize: 2 });
  assert.equal(w2[0].before.length, 2);
  assert.deepEqual(w2[0].before, ["bbb", "ccc"]);
  assert.equal(w2[0].after.length, 2);
  assert.deepEqual(w2[0].after, ["ddd", "eee"]);

  const w5 = findTokenWindows(strings, { tokens: TARGET_TOKENS, windowSize: 5 });
  assert.equal(w5[0].before.length, 3, "only 3 strings before the match");
  assert.deepEqual(w5[0].before, ["aaa", "bbb", "ccc"]);
  assert.equal(w5[0].after.length, 4, "only 4 strings after the match");
  assert.deepEqual(w5[0].after, ["ddd", "eee", "fff", "ggg"]);
});

test("findTokenWindows returns empty when no token matches", () => {
  const buf = buildBinary("random", "strings", "without", "targets");
  const strings = extractStrings(buf);
  const windows = findTokenWindows(strings, { tokens: TARGET_TOKENS });
  assert.equal(windows.length, 0);
});

test("findTokenWindows clips oversized binary context instead of losing the report", () => {
  const huge = "x".repeat(2000);
  const strings = extractStrings(buildBinary(huge, "CustomAgentSpec", huge));
  const windows = findTokenWindows(strings, { windowSize: 1, maxContextChars: 100 });
  assert.equal(windows.length, 1);
  assert.ok(windows[0].before[0].length <= 100);
  assert.match(windows[0].before[0], /\[clipped\]/);
});

test("findTokenWindows does not match partial token fragments", () => {
  // These contain substrings of target tokens but not the full token
  const buf = buildBinary("SdkCustom", "CustomAgent", "SdkCustomization", "SdkTool");
  const strings = extractStrings(buf);
  const windows = findTokenWindows(strings, { tokens: TARGET_TOKENS });
  assert.equal(windows.length, 0);
});

// ============================================================================
//  buildResult
// ============================================================================

test("buildResult returns expected result shape", () => {
  const strings = [
    { offset: 0, value: "a" },
    { offset: 10, value: "SdkCustomizationConfig" },
    { offset: 20, value: "b" },
  ];
  const windows = findTokenWindows(strings, { tokens: TARGET_TOKENS });
  const result = buildResult("/fake/binary", 100, strings, windows);

  assert.equal(result.ok, true);
  assert.equal(result.binaryPath, "/fake/binary");
  assert.equal(result.fileSize, 100);
  assert.deepEqual(result.targetTokens, [...TARGET_TOKENS]);
  assert.ok(result.matchesByToken.SdkCustomizationConfig >= 0);
  assert.equal(typeof result.totalStringsFound, "number");
  assert.equal(typeof result.totalWindows, "number");
  assert.ok(Array.isArray(result.windows));
  assert.equal(typeof result.truncated, "boolean");
});

test("buildResult truncates windows to fit maxOutputBytes", () => {
  const manyWindows = Array.from({ length: 50 }, (_, i) => ({
    token: "CustomAgentSpec",
    offset: i * 100,
    string: `CustomAgentSpec_${i}`,
    before: ["x".repeat(200)],
    after: ["y".repeat(200)],
  }));

  const strings = manyWindows.map((w, i) => ({ offset: w.offset, value: w.string }));
  const result = buildResult("/fake/binary", 99999, strings, manyWindows, {
    maxOutputBytes: 800,
  });

  assert.ok(result.truncated, "should have been truncated");
  assert.ok(result.windows.length < manyWindows.length, "should have fewer windows");
});

// ============================================================================
//  End-to-end with temporary synthetic binary
// ============================================================================

test("end-to-end: script extracts tokens from a temp synthetic binary", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "antigravity-proto-test-"));
  const binPath = join(tmpDir, "language_server.bin");

  try {
    // Build a realistic-looking synthetic binary with all three tokens
    const content = Buffer.concat([
      Buffer.from("proto_package\x00", "ascii"),
      Buffer.from("SdkCustomizationConfig\x00", "ascii"),
      Buffer.from("nested_target\x00", "ascii"),
      Buffer.from("SdkToolOverride\x00", "ascii"),
      Buffer.from("enabled_flag\x00", "ascii"),
      Buffer.from("preceding_field\x00", "ascii"),
      Buffer.from("CustomAgentSpec\x00", "ascii"),
      Buffer.from("custom_tools_field\x00", "ascii"),
      Buffer.from("trailing_data", "ascii"),
    ]);
    writeFileSync(binPath, content);

    const scriptPath = join(
      import.meta.dirname,
      "..",
      "..",
      "scripts",
      "extract-antigravity-protocol-strings.mjs",
    );
    const proc = spawnSync("node", [scriptPath, binPath], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });

    assert.equal(proc.status, 0, `CLI exited with code ${proc.status}: ${proc.stderr}`);
    assert.ok(proc.stdout.length > 0, "CLI produced no stdout");

    const result = JSON.parse(proc.stdout);
    assert.equal(result.ok, true);
    assert.equal(result.totalWindows, 3, "should find all three target tokens");

    const tokensFound = result.windows.map((w) => w.token).sort();
    assert.equal(tokensFound[0], "CustomAgentSpec");
    assert.equal(tokensFound[1], "SdkCustomizationConfig");
    assert.equal(tokensFound[2], "SdkToolOverride");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("end-to-end: EXTRACT_TOKENS searches custom protocol tokens", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "antigravity-proto-test-"));
  const binPath = join(tmpDir, "language_server.bin");

  try {
    writeFileSync(binPath, buildBinary("before", "RespondToInteraction", "after"));
    const scriptPath = join(
      import.meta.dirname,
      "..",
      "..",
      "scripts",
      "extract-antigravity-protocol-strings.mjs",
    );
    const proc = spawnSync("node", [scriptPath, binPath], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      env: { ...process.env, EXTRACT_TOKENS: "RespondToInteraction,ApproveInteraction" },
    });

    assert.equal(proc.status, 0, `CLI exited with code ${proc.status}: ${proc.stderr}`);
    const result = JSON.parse(proc.stdout);
    assert.equal(result.totalWindows, 1);
    assert.deepEqual(result.targetTokens, ["RespondToInteraction", "ApproveInteraction"]);
    assert.equal(result.windows[0].token, "RespondToInteraction");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("end-to-end: script errors on non-existent binary", () => {
  const scriptPath = join(
    import.meta.dirname,
    "..",
    "..",
    "scripts",
    "extract-antigravity-protocol-strings.mjs",
  );
  const proc = spawnSync("node", [scriptPath, "/nonexistent/path.bin"], {
    encoding: "utf8",
  });

  assert.notEqual(proc.status, 0, "should exit with non-zero code");
  assert.ok(proc.stderr.includes("Cannot read binary"), "should report read error");
});

test("end-to-end: script errors without binary path argument", () => {
  const scriptPath = join(
    import.meta.dirname,
    "..",
    "..",
    "scripts",
    "extract-antigravity-protocol-strings.mjs",
  );
  const proc = spawnSync("node", [scriptPath], { encoding: "utf8" });

  assert.notEqual(proc.status, 0, "should exit with non-zero code");
  assert.ok(proc.stderr.includes("Usage:"), "should print usage message");
});

// ============================================================================
//  Realistic scenario with dense proto-like fields
// ============================================================================

test("realistic protobuf-like field layout", () => {
  // Emulate the kind of fields you'd see near the target tokens in a
  // compiled protobuf binary.
  const protoFields = [
    "SdkCustomizationConfig",
    "allowCustomTools",
    "SdkToolOverride",
    "toolName",
    "toolDescription",
    "inputSchema",
    "enabled",
    "CustomAgentSpec",
    "agentName",
    "customTools",
    "plannerConfig",
  ];

  const buf = buildBinary(...protoFields);
  const strings = extractStrings(buf);
  const windows = findTokenWindows(strings, { tokens: TARGET_TOKENS });

  assert.equal(windows.length, 3, "should match all three tokens");

  // Check SdkCustomizationConfig neighbours
  const scc = windows.find((w) => w.token === "SdkCustomizationConfig");
  assert.ok(scc, "SdkCustomizationConfig match exists");
  assert.ok(scc.after.includes("allowCustomTools"), "should see field after SdkCustomizationConfig");

  // Check SdkToolOverride neighbours
  const sto = windows.find((w) => w.token === "SdkToolOverride");
  assert.ok(sto, "SdkToolOverride match exists");
  assert.ok(sto.before.includes("allowCustomTools"), "should see preceding field");
  assert.ok(sto.after.includes("toolName"), "should see field after");

  // Check CustomAgentSpec neighbours
  const cas = windows.find((w) => w.token === "CustomAgentSpec");
  assert.ok(cas, "CustomAgentSpec match exists");
  assert.ok(cas.before.includes("enabled"), "should see preceding field");
  assert.ok(cas.after.includes("agentName"), "should see field after");
  assert.ok(cas.after.includes("customTools"), "should see customTools nearby");
});
