import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const root = resolve(import.meta.dirname, "..", "..");
const validatorPath = resolve(root, "scripts", "test-anticodex-legacy-zero-hit.mjs");
const validatorSource = readFileSync(validatorPath, "utf8");

test("default workspace is project-relative rather than machine-specific", () => {
  assert.doesNotMatch(validatorSource, /G:\\Trae-Project\\Anti-Codex\\deepcodex/);
  assert.match(validatorSource, /resolve\(import\.meta\.dirname, "\.\."\)/);
});

function createTempFixtureDir() {
  const dir = join(tmpdir(), `anticodex-fixture-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function runValidator(workspaceRoot) {
  try {
    const output = execFileSync(process.execPath, [
      validatorPath,
      "--workspace-root", workspaceRoot,
      "--no-write-report"
    ], {
      encoding: "utf8",
      windowsHide: true
    });
    return {
      status: 0,
      payload: JSON.parse(output)
    };
  } catch (err) {
    return {
      status: err.status,
      payload: err.stdout ? JSON.parse(err.stdout) : null,
      stderr: err.stderr
    };
  }
}

test("reports failure when legacy files exist", () => {
  const dir = createTempFixtureDir();
  try {
    // Create one of the legacy files
    mkdirSync(join(dir, "translator"), { recursive: true });
    writeFileSync(join(dir, "translator", "adaptive-server.mjs"), "console.log('legacy');");

    const result = runValidator(dir);
    assert.equal(result.status, 1);
    assert.equal(result.payload.ok, false);
    assert.deepEqual(result.payload.legacyFilesExist, ["translator/adaptive-server.mjs"]);
    assert.equal(result.payload.forbiddenImports.length, 0);
    assert.equal(result.payload.forbiddenBehaviors.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reports failure when the obsolete DeepCodex launch stack returns", () => {
  const dir = createTempFixtureDir();
  try {
    mkdirSync(join(dir, "scripts"), { recursive: true });
    writeFileSync(join(dir, "scripts", "start-deepcodex.ps1"), "Write-Output 'legacy launcher'");

    const result = runValidator(dir);
    assert.equal(result.status, 1);
    assert.equal(result.payload.ok, false);
    assert.deepEqual(result.payload.legacyFilesExist, ["scripts/start-deepcodex.ps1"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reports failure on production imports/references", () => {
  const dir = createTempFixtureDir();
  try {
    // Create a remaining production file that imports a legacy file
    mkdirSync(join(dir, "translator", "provider"), { recursive: true });
    writeFileSync(join(dir, "translator", "provider", "my-adapter.mjs"), `
      import { something } from "../adaptive-server.mjs";
    `);

    const result = runValidator(dir);
    assert.equal(result.status, 1);
    assert.equal(result.payload.ok, false);
    assert.equal(result.payload.legacyFilesExist.length, 0);
    assert.deepEqual(result.payload.forbiddenImports, [
      { file: "translator/provider/my-adapter.mjs", legacyFile: "translator/adaptive-server.mjs" }
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reports failure on forbidden behavior families", () => {
  const dir = createTempFixtureDir();
  try {
    // Create a production file containing a forbidden behavior family name
    mkdirSync(join(dir, "translator", "provider"), { recursive: true });
    writeFileSync(join(dir, "translator", "provider", "my-adapter.mjs"), `
      const task = deterministicTask;
    `);

    const result = runValidator(dir);
    assert.equal(result.status, 1);
    assert.equal(result.payload.ok, false);
    assert.equal(result.payload.legacyFilesExist.length, 0);
    assert.deepEqual(result.payload.forbiddenBehaviors, [
      { file: "translator/provider/my-adapter.mjs", behavior: "deterministicTask" }
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("does not falsely report test/doc historical text", () => {
  const dir = createTempFixtureDir();
  try {
    // Create docs and tests containing references to legacy files and behavior families
    mkdirSync(join(dir, "docs"), { recursive: true });
    writeFileSync(join(dir, "docs", "manifest.md"), "adaptive-server.mjs and deterministicTask are legacy");

    mkdirSync(join(dir, "translator", "tests"), { recursive: true });
    writeFileSync(join(dir, "translator", "tests", "legacy.test.mjs"), "import '../adaptive-server.mjs'; const b = deterministicTask;");

    mkdirSync(join(dir, "scripts"), { recursive: true });
    writeFileSync(join(dir, "scripts", "test-legacy.mjs"), "adaptive-server.mjs reference");

    mkdirSync(join(dir, "third_party", "upstream"), { recursive: true });
    writeFileSync(join(dir, "third_party", "upstream", "server.mjs"), "const internalTools = true;");

    const result = runValidator(dir);
    assert.equal(result.status, 0);
    assert.equal(result.payload.ok, true);
    assert.equal(result.payload.legacyFilesExist.length, 0);
    assert.equal(result.payload.forbiddenImports.length, 0);
    assert.equal(result.payload.forbiddenBehaviors.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("approved installer cleanup ledger is not treated as an active import", () => {
  const dir = createTempFixtureDir();
  try {
    mkdirSync(join(dir, "scripts"), { recursive: true });
    writeFileSync(join(dir, "scripts", "install-anticodex.ps1"), `
$legacyRuntimeFiles = @(
  "translator\\adaptive-server.mjs",
  "translator\\antigravity-session-lock.mjs"
)
foreach ($relative in $legacyRuntimeFiles) {
  $legacyPath = Join-Path $runtime $relative
  Remove-Item -LiteralPath $legacyPath -Force
}
`);

    const result = runValidator(dir);
    assert.equal(result.status, 0);
    assert.equal(result.payload.ok, true);
    assert.deepEqual(result.payload.forbiddenImports, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("passes on clean fixtures", () => {
  const dir = createTempFixtureDir();
  try {
    // Create clean production files
    mkdirSync(join(dir, "translator", "provider"), { recursive: true });
    writeFileSync(join(dir, "translator", "provider", "clean.mjs"), `
      console.log("hello world");
    `);

    const result = runValidator(dir);
    assert.equal(result.status, 0);
    assert.equal(result.payload.ok, true);
    assert.equal(result.payload.legacyFilesExist.length, 0);
    assert.equal(result.payload.forbiddenImports.length, 0);
    assert.equal(result.payload.forbiddenBehaviors.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
