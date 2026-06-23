import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync, mkdirSync, readFileSync, readdirSync, statSync, lstatSync, rmSync, utimesSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..", "..");
const syncScript = resolve(root, "scripts", "sync-shared-codex-plugin-host.mjs");

function tmpDir() {
  return mkdtempSync(resolve(tmpdir(), "anticodex-skills-test-"));
}

test("--skills-only creates independent skills directory (not a symlink)", () => {
  const tmp = tmpDir();
  const codexHome = resolve(tmp, "codex");
  const sharedHome = resolve(tmp, "shared");

  mkdirSync(resolve(sharedHome, "skills", "alpha"), { recursive: true });
  writeFileSync(resolve(sharedHome, "skills", "alpha", "meta.json"), JSON.stringify({ v: 1 }));
  writeFileSync(resolve(sharedHome, "skills", "alpha", "run.js"), "// test");

  try {
    const result = spawnSync(process.execPath, [syncScript, codexHome, sharedHome, "--skills-only"], {
      encoding: "utf8",
    });

    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    const skillsPath = resolve(codexHome, "skills");
    assert.ok(statSync(skillsPath).isDirectory(), "skills must be a real directory");
    assert.ok(!lstatSync(skillsPath).isSymbolicLink(), "skills must not be a symlink");
    assert.strictEqual(readFileSync(resolve(skillsPath, "alpha", "meta.json"), "utf8"), JSON.stringify({ v: 1 }));
    assert.strictEqual(readFileSync(resolve(skillsPath, "alpha", "run.js"), "utf8"), "// test");

    const summary = JSON.parse(result.stdout);
    assert.ok(summary.ok);
    assert.strictEqual(summary.summary[0].mode, "copied");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("--skills-only merges shared skills into an existing local skills directory", () => {
  const tmp = tmpDir();
  const codexHome = resolve(tmp, "codex");
  const sharedHome = resolve(tmp, "shared");

  mkdirSync(resolve(codexHome, "skills", "local-only"), { recursive: true });
  writeFileSync(resolve(codexHome, "skills", "local-only", "code.js"), "local");
  mkdirSync(resolve(sharedHome, "skills", "tool-a"), { recursive: true });
  writeFileSync(resolve(sharedHome, "skills", "tool-a", "code.js"), "v1");

  try {
    const result = spawnSync(process.execPath, [syncScript, codexHome, sharedHome, "--skills-only"], {
      encoding: "utf8",
    });
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);

    const skillsPath = resolve(codexHome, "skills");
    assert.ok(statSync(skillsPath).isDirectory());
    assert.ok(!lstatSync(skillsPath).isSymbolicLink());

    assert.ok(statSync(resolve(skillsPath, "local-only")).isDirectory(), "local-only skill must be preserved");
    assert.ok(statSync(resolve(skillsPath, "tool-a")).isDirectory(), "tool-a must exist after re-import");
    assert.strictEqual(readFileSync(resolve(skillsPath, "local-only", "code.js"), "utf8"), "local");
    assert.strictEqual(readFileSync(resolve(skillsPath, "tool-a", "code.js"), "utf8"), "v1");

    const summary = JSON.parse(result.stdout);
    assert.ok(summary.ok);
    assert.strictEqual(summary.summary[0].mode, "copied");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("--skills-only only processes skills, never links plugins", () => {
  const tmp = tmpDir();
  const codexHome = resolve(tmp, "codex");
  const sharedHome = resolve(tmp, "shared");

  mkdirSync(resolve(sharedHome, "skills", "task-skill"), { recursive: true });
  writeFileSync(resolve(sharedHome, "skills", "task-skill", "main.js"), "// task");
  mkdirSync(resolve(sharedHome, "plugins"), { recursive: true });
  writeFileSync(resolve(sharedHome, "plugins", "marketplace.json"), "{}");

  try {
    const result = spawnSync(process.execPath, [syncScript, codexHome, sharedHome, "--skills-only"], {
      encoding: "utf8",
    });
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);

    const skillsPath = resolve(codexHome, "skills");
    assert.ok(statSync(skillsPath).isDirectory());
    assert.ok(!lstatSync(skillsPath).isSymbolicLink());
    assert.strictEqual(readFileSync(resolve(skillsPath, "task-skill", "main.js"), "utf8"), "// task");

    // Plugins must NOT have been linked or created by --import-skills
    assert.throws(() => statSync(resolve(codexHome, "plugins")), /ENOENT/);
    assert.throws(() => statSync(resolve(codexHome, "DEFAULT_SKILL_ALLOWLIST.md")), /ENOENT/);

    const summary = JSON.parse(result.stdout);
    assert.ok(summary.ok);
    assert.strictEqual(summary.summary.length, 1);
    assert.strictEqual(summary.summary[0].relPath, "skills");
    assert.strictEqual(summary.summary[0].mode, "copied");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("full sync imports all runtime snapshots as local copies", () => {
  const tmp = tmpDir();
  const codexHome = resolve(tmp, "codex");
  const sharedHome = resolve(tmp, "shared");

  mkdirSync(resolve(sharedHome, "skills", "legacy"), { recursive: true });
  writeFileSync(resolve(sharedHome, "skills", "legacy", "data.txt"), "backward");
  mkdirSync(resolve(sharedHome, "plugins"), { recursive: true });
  writeFileSync(resolve(sharedHome, "plugins", "marketplace.json"), "{}");
  mkdirSync(resolve(sharedHome, ".tmp", "plugins"), { recursive: true });
  writeFileSync(resolve(sharedHome, ".tmp", "plugins", "checkout.json"), "{}");
  mkdirSync(resolve(sharedHome, "computer-use"), { recursive: true });
  writeFileSync(resolve(sharedHome, "computer-use", "config.json"), "{}");
  mkdirSync(resolve(sharedHome, "skills", "legacy", ".git", "objects"), { recursive: true });
  writeFileSync(resolve(sharedHome, "skills", "legacy", ".git", "objects", "ignored"), "git-history");
  mkdirSync(resolve(sharedHome, "cache", "codex_app_directory"), { recursive: true });
  writeFileSync(resolve(sharedHome, "cache", "codex_app_directory", "dir.json"), JSON.stringify({ connectors: [] }));
  mkdirSync(resolve(sharedHome, "cache", "codex_apps_tools"), { recursive: true });
  writeFileSync(resolve(sharedHome, "cache", "codex_apps_tools", "tools.json"), JSON.stringify({ tools: [] }));
  for (const name of ["AGENTS.md", "DEFAULT_SKILL_ALLOWLIST.md", "RTK.md", "MCP_WORKER_USAGE_GUIDE.md"]) {
    writeFileSync(resolve(sharedHome, name), `${name} shared`);
  }

  try {
    const result = spawnSync(process.execPath, [syncScript, codexHome, sharedHome], {
      encoding: "utf8",
    });
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);

    const skillsPath = resolve(codexHome, "skills");
    assert.ok(statSync(skillsPath).isDirectory());
    assert.ok(!lstatSync(skillsPath).isSymbolicLink());
    assert.strictEqual(readFileSync(resolve(skillsPath, "legacy", "data.txt"), "utf8"), "backward");

    // codex_app_directory must be copied (not linked)
    const appDirPath = resolve(codexHome, "cache", "codex_app_directory");
    assert.ok(statSync(appDirPath).isDirectory());
    assert.ok(!lstatSync(appDirPath).isSymbolicLink());

    // codex_apps_tools must be copied (not linked)
    const appToolsPath = resolve(codexHome, "cache", "codex_apps_tools");
    assert.ok(statSync(appToolsPath).isDirectory());
    assert.ok(!lstatSync(appToolsPath).isSymbolicLink());

    // plugin and sidecar snapshots must be copied, not linked
    const pluginsPath = resolve(codexHome, "plugins");
    assert.ok(statSync(pluginsPath).isDirectory());
    assert.ok(!lstatSync(pluginsPath).isSymbolicLink());
    assert.strictEqual(readFileSync(resolve(pluginsPath, "marketplace.json"), "utf8"), "{}");
    assert.ok(!lstatSync(resolve(codexHome, ".tmp", "plugins")).isSymbolicLink());
    assert.ok(!lstatSync(resolve(codexHome, "computer-use")).isSymbolicLink());
    assert.throws(() => statSync(resolve(skillsPath, "legacy", ".git")), /ENOENT/);
    for (const name of ["AGENTS.md", "DEFAULT_SKILL_ALLOWLIST.md", "RTK.md", "MCP_WORKER_USAGE_GUIDE.md"]) {
      assert.strictEqual(readFileSync(resolve(codexHome, name), "utf8"), `${name} shared`);
      assert.ok(!lstatSync(resolve(codexHome, name)).isSymbolicLink());
    }

    const summary = JSON.parse(result.stdout);
    assert.ok(summary.ok);
    assert.deepStrictEqual(summary.summary.map((item) => item.relPath), [
      "skills",
      "AGENTS.md",
      "DEFAULT_SKILL_ALLOWLIST.md",
      "RTK.md",
      "MCP_WORKER_USAGE_GUIDE.md",
      "cache\\codex_app_directory",
      "plugins",
      ".tmp\\plugins",
      "cache\\codex_apps_tools",
      "computer-use",
    ]);
    assert.strictEqual(summary.summary[0].mode, "copied");
    assert.ok(summary.summary.slice(1, 5).every((item) => item.mode === "copied-file"));
    assert.ok(summary.summary.slice(5).every((item) => item.mode === "copied"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("--local-snapshots imports every required local runtime directory", () => {
  const tmp = tmpDir();
  const codexHome = resolve(tmp, "codex");
  const sharedHome = resolve(tmp, "shared");

  mkdirSync(resolve(sharedHome, "skills", "snap"), { recursive: true });
  writeFileSync(resolve(sharedHome, "skills", "snap", "f.txt"), "snapshot");
  mkdirSync(resolve(sharedHome, "cache", "codex_app_directory"), { recursive: true });
  writeFileSync(resolve(sharedHome, "cache", "codex_app_directory", "d.json"), "{}");
  mkdirSync(resolve(sharedHome, "cache", "codex_apps_tools"), { recursive: true });
  writeFileSync(resolve(sharedHome, "cache", "codex_apps_tools", "t.json"), "{}");
  mkdirSync(resolve(sharedHome, "plugins"), { recursive: true });
  writeFileSync(resolve(sharedHome, "plugins", "plugin.json"), "{}");
  mkdirSync(resolve(sharedHome, ".tmp", "plugins"), { recursive: true });
  writeFileSync(resolve(sharedHome, ".tmp", "plugins", "checkout.json"), "{}");
  mkdirSync(resolve(sharedHome, "computer-use"), { recursive: true });
  writeFileSync(resolve(sharedHome, "computer-use", "config.json"), "{}");
  for (const name of ["AGENTS.md", "DEFAULT_SKILL_ALLOWLIST.md", "RTK.md", "MCP_WORKER_USAGE_GUIDE.md"]) {
    writeFileSync(resolve(sharedHome, name), `${name} snapshot`);
  }

  try {
    const result = spawnSync(process.execPath, [syncScript, codexHome, sharedHome, "--local-snapshots"], {
      encoding: "utf8",
    });
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);

    // copy-mode directories must exist
    assert.ok(statSync(resolve(codexHome, "skills", "snap", "f.txt")).isFile());
    assert.ok(statSync(resolve(codexHome, "cache", "codex_app_directory", "d.json")).isFile());
    assert.ok(statSync(resolve(codexHome, "cache", "codex_apps_tools", "t.json")).isFile());

    assert.ok(statSync(resolve(codexHome, "plugins", "plugin.json")).isFile());
    assert.ok(statSync(resolve(codexHome, ".tmp", "plugins", "checkout.json")).isFile());
    assert.ok(statSync(resolve(codexHome, "computer-use", "config.json")).isFile());
    assert.ok(!lstatSync(resolve(codexHome, "plugins")).isSymbolicLink());
    assert.ok(!lstatSync(resolve(codexHome, ".tmp", "plugins")).isSymbolicLink());
    assert.ok(!lstatSync(resolve(codexHome, "computer-use")).isSymbolicLink());
    for (const name of ["AGENTS.md", "DEFAULT_SKILL_ALLOWLIST.md", "RTK.md", "MCP_WORKER_USAGE_GUIDE.md"]) {
      assert.strictEqual(readFileSync(resolve(codexHome, name), "utf8"), `${name} snapshot`);
    }

    const summary = JSON.parse(result.stdout);
    assert.ok(summary.ok);
    assert.strictEqual(summary.summary.length, 10);
    assert.ok(summary.summary.filter((item) => item.mode === "copied-file").length === 4);
    assert.ok(summary.summary.filter((item) => item.mode === "copied").length === 6);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("--startup-snapshots keeps existing required directories and skips plugin sidecars", () => {
  const tmp = tmpDir();
  const codexHome = resolve(tmp, "codex");
  const sharedHome = resolve(tmp, "shared");

  mkdirSync(resolve(codexHome, "skills", "existing"), { recursive: true });
  writeFileSync(resolve(codexHome, "skills", "existing", "value.txt"), "local");
  mkdirSync(resolve(sharedHome, "skills", "new-shared"), { recursive: true });
  writeFileSync(resolve(sharedHome, "skills", "new-shared", "value.txt"), "shared");
  mkdirSync(resolve(sharedHome, "plugins"), { recursive: true });
  writeFileSync(resolve(sharedHome, "plugins", "plugin.json"), "{}");
  mkdirSync(resolve(sharedHome, "cache", "codex_app_directory"), { recursive: true });
  writeFileSync(resolve(sharedHome, "cache", "codex_app_directory", "directory.json"), "{}");
  mkdirSync(resolve(sharedHome, "cache", "codex_apps_tools"), { recursive: true });
  writeFileSync(resolve(sharedHome, "cache", "codex_apps_tools", "tools.json"), "{}");
  writeFileSync(resolve(sharedHome, "AGENTS.md"), "startup guidance");

  try {
    const result = spawnSync(process.execPath, [syncScript, codexHome, sharedHome, "--startup-snapshots"], {
      encoding: "utf8",
      env: { ...process.env, ANTICODEX_EXTRA_SKILLS_ROOTS: resolve(tmp, "missing-agents-skills") },
    });
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    assert.strictEqual(readFileSync(resolve(codexHome, "skills", "existing", "value.txt"), "utf8"), "local");
    assert.strictEqual(readFileSync(resolve(codexHome, "skills", "new-shared", "value.txt"), "utf8"), "shared");
    assert.throws(() => statSync(resolve(codexHome, "plugins")), /ENOENT/);
    assert.strictEqual(readFileSync(resolve(codexHome, "AGENTS.md"), "utf8"), "startup guidance");
    assert.ok(statSync(resolve(codexHome, "cache", "codex_app_directory", "directory.json")).isFile());
    assert.ok(statSync(resolve(codexHome, "cache", "codex_apps_tools", "tools.json")).isFile());

    const summary = JSON.parse(result.stdout);
    assert.ok(summary.summary.some((item) => item.relPath === "skills" && ["kept-existing-startup-snapshot", "copied"].includes(item.mode)));
    const markerPath = resolve(codexHome, ".anticodex-startup-snapshots-ready.json");
    assert.ok(existsSync(markerPath), "startup snapshot sync must write a readiness marker");
    const marker = JSON.parse(readFileSync(markerPath, "utf8"));
    assert.strictEqual(marker.schema, "anticodex-startup-snapshots-ready-v1");
    assert.strictEqual(marker.codexHome, codexHome);
    assert.strictEqual(marker.sharedCodexHome, sharedHome);
    assert.deepStrictEqual(marker.extraSkillsRoots, [resolve(tmp, "missing-agents-skills")]);
    assert.strictEqual(marker.agentsSkillsPath, resolve(tmp, "missing-agents-skills"));
    assert.deepStrictEqual(marker.relPaths, [
      "skills",
      "AGENTS.md",
      "DEFAULT_SKILL_ALLOWLIST.md",
      "RTK.md",
      "MCP_WORKER_USAGE_GUIDE.md",
      "cache\\codex_app_directory",
      "cache\\codex_apps_tools",
    ]);
    // Marker must include source content fingerprint
    assert.ok(marker.sourceFingerprint, "marker must contain sourceFingerprint");
    assert.strictEqual(marker.sourceFingerprint.length, 32, "sourceFingerprint must be 32 hex chars");
    // Marker must include source mtime binding
    assert.ok(marker.sourceMtimeMax, "marker must contain sourceMtimeMax");
    assert.doesNotThrow(() => new Date(marker.sourceMtimeMax), "sourceMtimeMax must be a valid ISO date");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("--startup-snapshots marker supports a second lightweight launch without recopying directories", () => {
  const tmp = tmpDir();
  const codexHome = resolve(tmp, "codex");
  const sharedHome = resolve(tmp, "shared");

  mkdirSync(resolve(sharedHome, "skills", "demo"), { recursive: true });
  writeFileSync(resolve(sharedHome, "skills", "demo", "SKILL.md"), "demo");
  mkdirSync(resolve(sharedHome, "cache", "codex_app_directory"), { recursive: true });
  writeFileSync(resolve(sharedHome, "cache", "codex_app_directory", "entry.json"), "{}");
  mkdirSync(resolve(sharedHome, "cache", "codex_apps_tools"), { recursive: true });
  writeFileSync(resolve(sharedHome, "cache", "codex_apps_tools", "tools.json"), "{}");
  for (const name of ["AGENTS.md", "DEFAULT_SKILL_ALLOWLIST.md", "RTK.md", "MCP_WORKER_USAGE_GUIDE.md"]) {
    writeFileSync(resolve(sharedHome, name), name);
  }

  try {
    const first = spawnSync(process.execPath, [syncScript, codexHome, sharedHome, "--startup-snapshots"], {
      encoding: "utf8",
    });
    assert.strictEqual(first.status, 0, first.stderr || first.stdout);
    assert.ok(JSON.parse(first.stdout).ok);

    const second = spawnSync(process.execPath, [syncScript, codexHome, sharedHome, "--startup-snapshots"], {
      encoding: "utf8",
    });
    assert.strictEqual(second.status, 0, second.stderr || second.stdout);
    const summary = JSON.parse(second.stdout);
    assert.ok(summary.ok);
    assert.deepStrictEqual(
      summary.summary.filter((item) => item.mode === "kept-existing-startup-snapshot").map((item) => item.relPath),
      ["skills", "cache\\codex_app_directory", "cache\\codex_apps_tools"],
    );
    const marker = JSON.parse(readFileSync(resolve(codexHome, ".anticodex-startup-snapshots-ready.json"), "utf8"));
    assert.strictEqual(marker.codexHome, codexHome);
    assert.strictEqual(marker.sharedCodexHome, sharedHome);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("full sync preserves local-only content (transactional directory refresh)", () => {
  const tmp = tmpDir();
  const codexHome = resolve(tmp, "codex");
  const sharedHome = resolve(tmp, "shared");

  // Set up existing target with local-only content
  mkdirSync(resolve(codexHome, "skills", "local-custom"), { recursive: true });
  writeFileSync(resolve(codexHome, "skills", "local-custom", "my-skill.js"), "// local-only");
  mkdirSync(resolve(codexHome, "cache", "codex_app_directory"), { recursive: true });
  writeFileSync(resolve(codexHome, "cache", "codex_app_directory", "local.json"), "{}");
  mkdirSync(resolve(codexHome, "plugins"), { recursive: true });
  writeFileSync(resolve(codexHome, "plugins", "local.txt"), "local");

  // Set up shared source (partially overlapping with target)
  mkdirSync(resolve(sharedHome, "skills", "shared-a"), { recursive: true });
  writeFileSync(resolve(sharedHome, "skills", "shared-a", "main.js"), "// shared");
  mkdirSync(resolve(sharedHome, "cache", "codex_app_directory"), { recursive: true });
  writeFileSync(resolve(sharedHome, "cache", "codex_app_directory", "shared.json"), "{}");
  mkdirSync(resolve(sharedHome, "plugins"), { recursive: true });
  writeFileSync(resolve(sharedHome, "plugins", "shared.json"), "{}");
  mkdirSync(resolve(sharedHome, ".tmp", "plugins"), { recursive: true });
  writeFileSync(resolve(sharedHome, ".tmp", "plugins", "c.json"), "{}");
  mkdirSync(resolve(sharedHome, "computer-use"), { recursive: true });
  writeFileSync(resolve(sharedHome, "computer-use", "config.json"), "{}");
  mkdirSync(resolve(sharedHome, "cache", "codex_apps_tools"), { recursive: true });
  writeFileSync(resolve(sharedHome, "cache", "codex_apps_tools", "t.json"), "{}");
  for (const name of ["AGENTS.md", "DEFAULT_SKILL_ALLOWLIST.md", "RTK.md", "MCP_WORKER_USAGE_GUIDE.md"]) {
    writeFileSync(resolve(sharedHome, name), `${name} shared`);
  }

  try {
    const result = spawnSync(process.execPath, [syncScript, codexHome, sharedHome], {
      encoding: "utf8",
    });
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);

    // Local-only content must survive the transactional refresh
    assert.strictEqual(
      readFileSync(resolve(codexHome, "skills", "local-custom", "my-skill.js"), "utf8"),
      "// local-only"
    );
    assert.strictEqual(
      readFileSync(resolve(codexHome, "cache", "codex_app_directory", "local.json"), "utf8"),
      "{}"
    );
    assert.strictEqual(
      readFileSync(resolve(codexHome, "plugins", "local.txt"), "utf8"),
      "local"
    );

    // Shared content must be imported
    assert.strictEqual(
      readFileSync(resolve(codexHome, "skills", "shared-a", "main.js"), "utf8"),
      "// shared"
    );
    assert.strictEqual(
      readFileSync(resolve(codexHome, "cache", "codex_app_directory", "shared.json"), "utf8"),
      "{}"
    );
    assert.strictEqual(
      readFileSync(resolve(codexHome, "plugins", "shared.json"), "utf8"),
      "{}"
    );

    const summary = JSON.parse(result.stdout);
    assert.ok(summary.ok);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("no temporary or backup artifact directories remain after sync", () => {
  const tmp = tmpDir();
  const codexHome = resolve(tmp, "codex");
  const sharedHome = resolve(tmp, "shared");

  mkdirSync(resolve(sharedHome, "skills", "alpha"), { recursive: true });
  writeFileSync(resolve(sharedHome, "skills", "alpha", "code.js"), "// v1");
  mkdirSync(resolve(sharedHome, "plugins"), { recursive: true });
  writeFileSync(resolve(sharedHome, "plugins", "d.json"), "{}");
  mkdirSync(resolve(sharedHome, ".tmp", "plugins"), { recursive: true });
  writeFileSync(resolve(sharedHome, ".tmp", "plugins", "c.json"), "{}");
  mkdirSync(resolve(sharedHome, "computer-use"), { recursive: true });
  writeFileSync(resolve(sharedHome, "computer-use", "config.json"), "{}");
  mkdirSync(resolve(sharedHome, "cache", "codex_app_directory"), { recursive: true });
  writeFileSync(resolve(sharedHome, "cache", "codex_app_directory", "d.json"), "{}");
  mkdirSync(resolve(sharedHome, "cache", "codex_apps_tools"), { recursive: true });
  writeFileSync(resolve(sharedHome, "cache", "codex_apps_tools", "t.json"), "{}");
  for (const name of ["AGENTS.md", "DEFAULT_SKILL_ALLOWLIST.md", "RTK.md", "MCP_WORKER_USAGE_GUIDE.md"]) {
    writeFileSync(resolve(sharedHome, name), `${name} shared`);
  }

  try {
    const result = spawnSync(process.execPath, [syncScript, codexHome, sharedHome], {
      encoding: "utf8",
    });
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);

    // Check key directories for leftover temp/old artifacts
    for (const dir of [codexHome, resolve(codexHome, "cache"), resolve(codexHome, ".tmp")]) {
      let entries;
      try {
        entries = readdirSync(dir);
      } catch {
        // Directory does not exist on this run; skip
        continue;
      }
      const leftovers = entries.filter(
        (e) => e.includes(".tmp-") || e.includes(".old-")
      );
      assert.strictEqual(
        leftovers.length,
        0,
        `Leftover temp/old files in ${dir}: ${leftovers.join(", ")}`
      );
    }

    const summary = JSON.parse(result.stdout);
    assert.ok(summary.ok);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("transactional file copy uses temp file and leaves no residue", () => {
  const tmp = tmpDir();
  const codexHome = resolve(tmp, "codex");
  const sharedHome = resolve(tmp, "shared");

  // Set up shared source with one copy directory and one copied file.
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(resolve(codexHome, "AGENTS.md"), "old agents content");
  mkdirSync(resolve(sharedHome, "skills", "y"), { recursive: true });
  writeFileSync(resolve(sharedHome, "skills", "y", "z.txt"), "content");
  writeFileSync(resolve(sharedHome, "AGENTS.md"), "agents content");

  try {
    const result = spawnSync(process.execPath, [syncScript, codexHome, sharedHome], {
      encoding: "utf8",
    });
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);

    // Verify file contents
    assert.strictEqual(
      readFileSync(resolve(codexHome, "AGENTS.md"), "utf8"),
      "agents content"
    );
    assert.ok(statSync(resolve(codexHome, "skills", "y", "z.txt")).isFile());

    // Check for leftover temp files alongside AGENTS.md
    const codexEntries = readdirSync(codexHome);
    const fileLeftovers = codexEntries.filter(
      (e) => e.startsWith("AGENTS.md.tmp-") || e.startsWith("AGENTS.md.old-")
    );
    assert.strictEqual(
      fileLeftovers.length,
      0,
      `Leftover temp files: ${fileLeftovers.join(", ")}`
    );

    const summary = JSON.parse(result.stdout);
    assert.ok(summary.ok);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("transactional directory refresh handles shared file and directory type changes", () => {
  const tmp = tmpDir();
  const codexHome = resolve(tmp, "codex");
  const sharedHome = resolve(tmp, "shared");

  mkdirSync(resolve(codexHome, "skills", "file-to-dir"), { recursive: true });
  writeFileSync(resolve(codexHome, "skills", "file-to-dir", "entry"), "old file");
  mkdirSync(resolve(codexHome, "skills", "dir-to-file", "entry"), { recursive: true });
  writeFileSync(resolve(codexHome, "skills", "dir-to-file", "entry", "old.txt"), "old");

  mkdirSync(resolve(sharedHome, "skills", "file-to-dir", "entry"), { recursive: true });
  writeFileSync(resolve(sharedHome, "skills", "file-to-dir", "entry", "new.txt"), "new");
  mkdirSync(resolve(sharedHome, "skills", "dir-to-file"), { recursive: true });
  writeFileSync(resolve(sharedHome, "skills", "dir-to-file", "entry"), "new file");

  try {
    const result = spawnSync(process.execPath, [syncScript, codexHome, sharedHome, "--skills-only"], {
      encoding: "utf8",
    });
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    assert.strictEqual(readFileSync(resolve(codexHome, "skills", "file-to-dir", "entry", "new.txt"), "utf8"), "new");
    assert.strictEqual(readFileSync(resolve(codexHome, "skills", "dir-to-file", "entry"), "utf8"), "new file");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("a concurrent local snapshot refresh fails before changing the active snapshot", () => {
  const tmp = tmpDir();
  const codexHome = resolve(tmp, "codex");
  const sharedHome = resolve(tmp, "shared");

  mkdirSync(resolve(codexHome, "skills", "existing"), { recursive: true });
  writeFileSync(resolve(codexHome, "skills", "existing", "value.txt"), "active");
  writeFileSync(resolve(codexHome, ".sync-shared-codex-plugin-host.lock"), "another process");
  mkdirSync(resolve(sharedHome, "skills", "replacement"), { recursive: true });
  writeFileSync(resolve(sharedHome, "skills", "replacement", "value.txt"), "replacement");

  try {
    const result = spawnSync(process.execPath, [syncScript, codexHome, sharedHome, "--skills-only"], {
      encoding: "utf8",
    });
    assert.notStrictEqual(result.status, 0);
    assert.match(result.stderr, /already running/);
    assert.strictEqual(readFileSync(resolve(codexHome, "skills", "existing", "value.txt"), "utf8"), "active");
    assert.throws(() => statSync(resolve(codexHome, "skills", "replacement")), /ENOENT/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("a stale local snapshot refresh lock is discarded before syncing", () => {
  const tmp = tmpDir();
  const codexHome = resolve(tmp, "codex");
  const sharedHome = resolve(tmp, "shared");

  mkdirSync(codexHome, { recursive: true });
  writeFileSync(resolve(codexHome, ".sync-shared-codex-plugin-host.lock"), "stale process");
  const staleDate = new Date(Date.now() - 5000);
  utimesSync(resolve(codexHome, ".sync-shared-codex-plugin-host.lock"), staleDate, staleDate);
  mkdirSync(resolve(sharedHome, "skills", "replacement"), { recursive: true });
  writeFileSync(resolve(sharedHome, "skills", "replacement", "value.txt"), "replacement");

  try {
    const result = spawnSync(process.execPath, [syncScript, codexHome, sharedHome, "--skills-only"], {
      encoding: "utf8",
      env: { ...process.env, ANTICODEX_SNAPSHOT_LOCK_STALE_MS: "1000" },
    });
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    assert.strictEqual(readFileSync(resolve(codexHome, "skills", "replacement", "value.txt"), "utf8"), "replacement");
    assert.ok(!existsSync(resolve(codexHome, ".sync-shared-codex-plugin-host.lock")));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("stale transaction artifacts are cleaned before sync", () => {
  const tmp = tmpDir();
  const codexHome = resolve(tmp, "codex");
  const sharedHome = resolve(tmp, "shared");

  mkdirSync(resolve(sharedHome, "skills", "fresh"), { recursive: true });
  writeFileSync(resolve(sharedHome, "skills", "fresh", "value.txt"), "fresh");
  writeFileSync(resolve(sharedHome, "AGENTS.md"), "fresh agents");
  mkdirSync(resolve(codexHome, "skills.tmp-deadbeef", "old"), { recursive: true });
  writeFileSync(resolve(codexHome, "skills.tmp-deadbeef", "old", "value.txt"), "stale temp");
  mkdirSync(resolve(codexHome, "skills.old-deadbeef", "old"), { recursive: true });
  writeFileSync(resolve(codexHome, "skills.old-deadbeef", "old", "value.txt"), "stale old");
  writeFileSync(resolve(codexHome, "AGENTS.md.tmp-deadbeef"), "stale file temp");
  writeFileSync(resolve(codexHome, "AGENTS.md.old-deadbeef"), "stale file old");
  const staleDate = new Date(Date.now() - 5000);
  utimesSync(resolve(codexHome, "skills.tmp-deadbeef"), staleDate, staleDate);
  utimesSync(resolve(codexHome, "skills.old-deadbeef"), staleDate, staleDate);
  utimesSync(resolve(codexHome, "AGENTS.md.tmp-deadbeef"), staleDate, staleDate);
  utimesSync(resolve(codexHome, "AGENTS.md.old-deadbeef"), staleDate, staleDate);

  try {
    const result = spawnSync(process.execPath, [syncScript, codexHome, sharedHome, "--startup-snapshots"], {
      encoding: "utf8",
      env: { ...process.env, ANTICODEX_SNAPSHOT_ARTIFACT_STALE_MS: "1000" },
    });
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    assert.ok(!existsSync(resolve(codexHome, "skills.tmp-deadbeef")));
    assert.ok(!existsSync(resolve(codexHome, "skills.old-deadbeef")));
    assert.ok(!existsSync(resolve(codexHome, "AGENTS.md.tmp-deadbeef")));
    assert.ok(!existsSync(resolve(codexHome, "AGENTS.md.old-deadbeef")));
    assert.strictEqual(readFileSync(resolve(codexHome, "skills", "fresh", "value.txt"), "utf8"), "fresh");
    assert.strictEqual(readFileSync(resolve(codexHome, "AGENTS.md"), "utf8"), "fresh agents");
    const summary = JSON.parse(result.stdout);
    assert.deepStrictEqual(summary.cleanup.sort(), [
      "AGENTS.md.old-deadbeef",
      "AGENTS.md.tmp-deadbeef",
      "skills.old-deadbeef",
      "skills.tmp-deadbeef",
    ]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("fresh transaction artifacts are left for the active owner", () => {
  const tmp = tmpDir();
  const codexHome = resolve(tmp, "codex");
  const sharedHome = resolve(tmp, "shared");

  mkdirSync(resolve(sharedHome, "skills", "fresh"), { recursive: true });
  writeFileSync(resolve(sharedHome, "skills", "fresh", "value.txt"), "fresh");
  mkdirSync(resolve(codexHome, "skills.tmp-deadbeef"), { recursive: true });
  writeFileSync(resolve(codexHome, "skills.tmp-deadbeef", "value.txt"), "active temp");

  try {
    const result = spawnSync(process.execPath, [syncScript, codexHome, sharedHome, "--skills-only"], {
      encoding: "utf8",
      env: { ...process.env, ANTICODEX_SNAPSHOT_ARTIFACT_STALE_MS: "86400000" },
    });
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    assert.ok(existsSync(resolve(codexHome, "skills.tmp-deadbeef")));
    assert.strictEqual(readFileSync(resolve(codexHome, "skills", "fresh", "value.txt"), "utf8"), "fresh");
    const summary = JSON.parse(result.stdout);
    assert.deepStrictEqual(summary.cleanup, []);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("missing shared startup sources do not create empty snapshot parent directories", () => {
  const tmp = tmpDir();
  const codexHome = resolve(tmp, "codex");
  const sharedHome = resolve(tmp, "shared");

  mkdirSync(sharedHome, { recursive: true });

  try {
    const result = spawnSync(process.execPath, [syncScript, codexHome, sharedHome, "--startup-snapshots"], {
      encoding: "utf8",
      env: { ...process.env, ANTICODEX_EXTRA_SKILLS_ROOTS: resolve(tmp, "missing-agents-skills") },
    });
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    assert.ok(existsSync(resolve(codexHome, ".anticodex-startup-snapshots-ready.json")));
    assert.ok(!existsSync(resolve(codexHome, "cache")));
    assert.ok(!existsSync(resolve(codexHome, "skills")));
    const summary = JSON.parse(result.stdout);
    assert.ok(summary.ok);
    assert.ok(summary.summary.every((item) => item.mode === "missing-shared-target"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("full sync deletes previously-synced entries that were removed from shared source", () => {
  const tmp = tmpDir();
  const codexHome = resolve(tmp, "codex");
  const sharedHome = resolve(tmp, "shared");

  // First sync: set up shared source with two skills
  mkdirSync(resolve(sharedHome, "skills", "tool-a"), { recursive: true });
  writeFileSync(resolve(sharedHome, "skills", "tool-a", "code.js"), "v1");
  mkdirSync(resolve(sharedHome, "skills", "tool-b"), { recursive: true });
  writeFileSync(resolve(sharedHome, "skills", "tool-b", "code.js"), "v2");

  try {
    const result1 = spawnSync(process.execPath, [syncScript, codexHome, sharedHome, "--skills-only"], {
      encoding: "utf8",
    });
    assert.strictEqual(result1.status, 0, result1.stderr || result1.stdout);
    assert.ok(JSON.parse(result1.stdout).ok);
    assert.ok(statSync(resolve(codexHome, "skills", "tool-a", "code.js")).isFile());
    assert.ok(statSync(resolve(codexHome, "skills", "tool-b", "code.js")).isFile());

    // Second sync: delete tool-b from shared source
    rmSync(resolve(sharedHome, "skills", "tool-b"), { recursive: true, force: true });

    const result2 = spawnSync(process.execPath, [syncScript, codexHome, sharedHome, "--skills-only"], {
      encoding: "utf8",
    });
    assert.strictEqual(result2.status, 0, result2.stderr || result2.stdout);

    // tool-a must still exist (not deleted from source)
    assert.ok(statSync(resolve(codexHome, "skills", "tool-a", "code.js")).isFile());
    // tool-b must be pruned (deleted from source, tracked in old manifest)
    assert.throws(() => statSync(resolve(codexHome, "skills", "tool-b")), /ENOENT/);

    // Source manifest must be written
    const manifestPath = resolve(codexHome, "skills", ".anticodex-source-manifest.json");
    assert.ok(existsSync(manifestPath), "source manifest must exist after sync");

    const summary2 = JSON.parse(result2.stdout);
    assert.ok(summary2.ok);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("full sync deletes previously-synced directories removed from shared source while preserving unchanged entries", () => {
  const tmp = tmpDir();
  const codexHome = resolve(tmp, "codex");
  const sharedHome = resolve(tmp, "shared");

  // Set up shared source with a skill and all guidance files
  mkdirSync(resolve(sharedHome, "skills", "alpha"), { recursive: true });
  writeFileSync(resolve(sharedHome, "skills", "alpha", "run.js"), "// alpha");
  mkdirSync(resolve(sharedHome, "skills", "beta"), { recursive: true });
  writeFileSync(resolve(sharedHome, "skills", "beta", "run.js"), "// beta");
  for (const name of ["AGENTS.md", "DEFAULT_SKILL_ALLOWLIST.md", "RTK.md", "MCP_WORKER_USAGE_GUIDE.md"]) {
    writeFileSync(resolve(sharedHome, name), name);
  }
  mkdirSync(resolve(sharedHome, "plugins"), { recursive: true });
  writeFileSync(resolve(sharedHome, "plugins", "marketplace.json"), "{}");
  mkdirSync(resolve(sharedHome, ".tmp", "plugins"), { recursive: true });
  writeFileSync(resolve(sharedHome, ".tmp", "plugins", "c.json"), "{}");
  mkdirSync(resolve(sharedHome, "computer-use"), { recursive: true });
  writeFileSync(resolve(sharedHome, "computer-use", "config.json"), "{}");
  mkdirSync(resolve(sharedHome, "cache", "codex_app_directory"), { recursive: true });
  writeFileSync(resolve(sharedHome, "cache", "codex_app_directory", "dir.json"), "{}");
  mkdirSync(resolve(sharedHome, "cache", "codex_apps_tools"), { recursive: true });
  writeFileSync(resolve(sharedHome, "cache", "codex_apps_tools", "tools.json"), "{}");

  try {
    // First full sync
    const result1 = spawnSync(process.execPath, [syncScript, codexHome, sharedHome], {
      encoding: "utf8",
    });
    assert.strictEqual(result1.status, 0, result1.stderr || result1.stdout);
    assert.ok(JSON.parse(result1.stdout).ok);
    assert.ok(statSync(resolve(codexHome, "skills", "alpha", "run.js")).isFile());
    assert.ok(statSync(resolve(codexHome, "skills", "beta", "run.js")).isFile());
    assert.strictEqual(readFileSync(resolve(codexHome, "AGENTS.md"), "utf8"), "AGENTS.md");
    assert.strictEqual(readFileSync(resolve(codexHome, "RTK.md"), "utf8"), "RTK.md");

    // Remove skill alpha (directory with manifest tracking) from shared source;
    // keep beta and all guidance files.
    rmSync(resolve(sharedHome, "skills", "alpha"), { recursive: true, force: true });

    // Second full sync
    const result2 = spawnSync(process.execPath, [syncScript, codexHome, sharedHome], {
      encoding: "utf8",
    });
    assert.strictEqual(result2.status, 0, result2.stderr || result2.stdout);

    // Deleted skill alpha must be pruned (tracked via manifest)
    assert.throws(() => statSync(resolve(codexHome, "skills", "alpha")), /ENOENT/);
    // Beta skill must survive (still in source)
    assert.ok(statSync(resolve(codexHome, "skills", "beta")).isDirectory());
    assert.strictEqual(readFileSync(resolve(codexHome, "skills", "beta", "run.js"), "utf8"), "// beta");
    // Guidance files (copy-file mode) must survive (not removed by manifest pruning)
    assert.strictEqual(readFileSync(resolve(codexHome, "AGENTS.md"), "utf8"), "AGENTS.md");
    assert.strictEqual(readFileSync(resolve(codexHome, "RTK.md"), "utf8"), "RTK.md");

    // Source manifest must be written for directory-mode targets
    assert.ok(existsSync(resolve(codexHome, "skills", ".anticodex-source-manifest.json")));
    assert.ok(existsSync(resolve(codexHome, "plugins", ".anticodex-source-manifest.json")));

    const summary2 = JSON.parse(result2.stdout);
    assert.ok(summary2.ok);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("pruning preserves local-only entries while removing previously-synced deleted entries", () => {
  const tmp = tmpDir();
  const codexHome = resolve(tmp, "codex");
  const sharedHome = resolve(tmp, "shared");

  // First sync: shared source has tool-a
  mkdirSync(resolve(sharedHome, "skills", "tool-a"), { recursive: true });
  writeFileSync(resolve(sharedHome, "skills", "tool-a", "code.js"), "shared");

  try {
    const result1 = spawnSync(process.execPath, [syncScript, codexHome, sharedHome, "--skills-only"], {
      encoding: "utf8",
    });
    assert.strictEqual(result1.status, 0, result1.stderr || result1.stdout);
    assert.ok(JSON.parse(result1.stdout).ok);
    assert.ok(statSync(resolve(codexHome, "skills", "tool-a")).isDirectory());

    // Add a local-only entry that was NOT in the shared source
    mkdirSync(resolve(codexHome, "skills", "my-local-custom"), { recursive: true });
    writeFileSync(resolve(codexHome, "skills", "my-local-custom", "custom.js"), "local-custom");

    // Delete tool-a from shared source
    rmSync(resolve(sharedHome, "skills", "tool-a"), { recursive: true, force: true });

    // Second sync: tool-a should be pruned, local-only should survive
    const result2 = spawnSync(process.execPath, [syncScript, codexHome, sharedHome, "--skills-only"], {
      encoding: "utf8",
    });
    assert.strictEqual(result2.status, 0, result2.stderr || result2.stdout);

    // tool-a must be pruned
    assert.throws(() => statSync(resolve(codexHome, "skills", "tool-a")), /ENOENT/);
    // Local-only entry must survive
    assert.ok(statSync(resolve(codexHome, "skills", "my-local-custom")).isDirectory());
    assert.strictEqual(readFileSync(resolve(codexHome, "skills", "my-local-custom", "custom.js"), "utf8"), "local-custom");

    const summary2 = JSON.parse(result2.stdout);
    assert.ok(summary2.ok);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("startup snapshot marker contains source content fingerprint and mtime binding", () => {
  const tmp = tmpDir();
  const codexHome = resolve(tmp, "codex");
  const sharedHome = resolve(tmp, "shared");

  mkdirSync(resolve(sharedHome, "skills", "demo"), { recursive: true });
  writeFileSync(resolve(sharedHome, "skills", "demo", "SKILL.md"), "demo content");
  mkdirSync(resolve(sharedHome, "cache", "codex_app_directory"), { recursive: true });
  writeFileSync(resolve(sharedHome, "cache", "codex_app_directory", "e.json"), "{}");
  mkdirSync(resolve(sharedHome, "cache", "codex_apps_tools"), { recursive: true });
  writeFileSync(resolve(sharedHome, "cache", "codex_apps_tools", "t.json"), "{}");
  for (const name of ["AGENTS.md", "DEFAULT_SKILL_ALLOWLIST.md", "RTK.md", "MCP_WORKER_USAGE_GUIDE.md"]) {
    writeFileSync(resolve(sharedHome, name), name);
  }

  try {
    const result = spawnSync(process.execPath, [syncScript, codexHome, sharedHome, "--startup-snapshots"], {
      encoding: "utf8",
    });
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    assert.ok(JSON.parse(result.stdout).ok);

    const markerPath = resolve(codexHome, ".anticodex-startup-snapshots-ready.json");
    assert.ok(existsSync(markerPath), "marker must exist");
    const marker = JSON.parse(readFileSync(markerPath, "utf8"));

    // Marker must have source fingerprint
    assert.ok(marker.sourceFingerprint, "marker must contain sourceFingerprint");
    assert.strictEqual(marker.sourceFingerprint.length, 32, "sourceFingerprint must be 32 hex chars");

    // Marker must have source mtime binding
    assert.ok(marker.sourceMtimeMax, "marker must contain sourceMtimeMax");
    assert.doesNotThrow(() => new Date(marker.sourceMtimeMax), "sourceMtimeMax must be a valid ISO date");

    // Verify schema and paths
    assert.strictEqual(marker.schema, "anticodex-startup-snapshots-ready-v1");
    assert.strictEqual(marker.codexHome, codexHome);
    assert.strictEqual(marker.sharedCodexHome, sharedHome);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("--print-startup-source-fingerprint reports the same fingerprint without writing snapshots", () => {
  const tmp = tmpDir();
  const codexHome = resolve(tmp, "codex");
  const sharedHome = resolve(tmp, "shared");

  mkdirSync(resolve(sharedHome, "skills", "demo"), { recursive: true });
  writeFileSync(resolve(sharedHome, "skills", "demo", "SKILL.md"), "demo content");
  mkdirSync(resolve(sharedHome, "cache", "codex_app_directory"), { recursive: true });
  writeFileSync(resolve(sharedHome, "cache", "codex_app_directory", "e.json"), "{}");
  mkdirSync(resolve(sharedHome, "cache", "codex_apps_tools"), { recursive: true });
  writeFileSync(resolve(sharedHome, "cache", "codex_apps_tools", "t.json"), "{}");
  for (const name of ["AGENTS.md", "DEFAULT_SKILL_ALLOWLIST.md", "RTK.md", "MCP_WORKER_USAGE_GUIDE.md"]) {
    writeFileSync(resolve(sharedHome, name), name);
  }

  try {
    const printed = spawnSync(process.execPath, [
      syncScript,
      codexHome,
      sharedHome,
      "--startup-snapshots",
      "--print-startup-source-fingerprint",
    ], {
      encoding: "utf8",
    });
    assert.strictEqual(printed.status, 0, printed.stderr || printed.stdout);
    const printedSummary = JSON.parse(printed.stdout);
    assert.ok(printedSummary.ok);
    assert.ok(printedSummary.sourceFingerprint);
    assert.strictEqual(printedSummary.sourceFingerprint.length, 32);
    assert.ok(!existsSync(resolve(codexHome, ".anticodex-startup-snapshots-ready.json")));
    assert.ok(!existsSync(resolve(codexHome, "skills")));

    const synced = spawnSync(process.execPath, [syncScript, codexHome, sharedHome, "--startup-snapshots"], {
      encoding: "utf8",
    });
    assert.strictEqual(synced.status, 0, synced.stderr || synced.stdout);
    const marker = JSON.parse(readFileSync(resolve(codexHome, ".anticodex-startup-snapshots-ready.json"), "utf8"));
    assert.strictEqual(marker.sourceFingerprint, printedSummary.sourceFingerprint);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("--local-snapshots marker uses the startup freshness fingerprint", () => {
  const tmp = tmpDir();
  const codexHome = resolve(tmp, "codex");
  const sharedHome = resolve(tmp, "shared");

  mkdirSync(resolve(sharedHome, "skills", "demo"), { recursive: true });
  writeFileSync(resolve(sharedHome, "skills", "demo", "SKILL.md"), "demo content");
  mkdirSync(resolve(sharedHome, "cache", "codex_app_directory"), { recursive: true });
  writeFileSync(resolve(sharedHome, "cache", "codex_app_directory", "e.json"), "{}");
  mkdirSync(resolve(sharedHome, "cache", "codex_apps_tools"), { recursive: true });
  writeFileSync(resolve(sharedHome, "cache", "codex_apps_tools", "t.json"), "{}");
  mkdirSync(resolve(sharedHome, "plugins", "extra"), { recursive: true });
  writeFileSync(resolve(sharedHome, "plugins", "extra", "plugin.json"), "extra plugin content");
  mkdirSync(resolve(sharedHome, "computer-use"), { recursive: true });
  writeFileSync(resolve(sharedHome, "computer-use", "state.json"), "extra computer-use content");
  for (const name of ["AGENTS.md", "DEFAULT_SKILL_ALLOWLIST.md", "RTK.md", "MCP_WORKER_USAGE_GUIDE.md"]) {
    writeFileSync(resolve(sharedHome, name), name);
  }

  try {
    const printed = spawnSync(process.execPath, [
      syncScript,
      codexHome,
      sharedHome,
      "--startup-snapshots",
      "--print-startup-source-fingerprint",
    ], {
      encoding: "utf8",
    });
    assert.strictEqual(printed.status, 0, printed.stderr || printed.stdout);
    const printedSummary = JSON.parse(printed.stdout);

    const local = spawnSync(process.execPath, [syncScript, codexHome, sharedHome, "--local-snapshots"], {
      encoding: "utf8",
    });
    assert.strictEqual(local.status, 0, local.stderr || local.stdout);
    const marker = JSON.parse(readFileSync(resolve(codexHome, ".anticodex-startup-snapshots-ready.json"), "utf8"));

    assert.strictEqual(marker.sourceFingerprint, printedSummary.sourceFingerprint);
    assert.deepStrictEqual(marker.relPaths.sort(), [
      "AGENTS.md",
      "DEFAULT_SKILL_ALLOWLIST.md",
      "MCP_WORKER_USAGE_GUIDE.md",
      "RTK.md",
      join("cache", "codex_app_directory"),
      join("cache", "codex_apps_tools"),
      "skills",
    ].sort());
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("marker fingerprint changes when shared source content changes", () => {
  const tmp = tmpDir();
  const codexHome = resolve(tmp, "codex");
  const sharedHome = resolve(tmp, "shared");

  mkdirSync(resolve(sharedHome, "skills", "demo"), { recursive: true });
  writeFileSync(resolve(sharedHome, "skills", "demo", "SKILL.md"), "v1");
  mkdirSync(resolve(sharedHome, "cache", "codex_app_directory"), { recursive: true });
  writeFileSync(resolve(sharedHome, "cache", "codex_app_directory", "e.json"), "{}");
  mkdirSync(resolve(sharedHome, "cache", "codex_apps_tools"), { recursive: true });
  writeFileSync(resolve(sharedHome, "cache", "codex_apps_tools", "t.json"), "{}");
  for (const name of ["AGENTS.md", "DEFAULT_SKILL_ALLOWLIST.md", "RTK.md", "MCP_WORKER_USAGE_GUIDE.md"]) {
    writeFileSync(resolve(sharedHome, name), name);
  }

  try {
    // First run
    const result1 = spawnSync(process.execPath, [syncScript, codexHome, sharedHome, "--startup-snapshots"], {
      encoding: "utf8",
    });
    assert.strictEqual(result1.status, 0, result1.stderr || result1.stdout);
    assert.ok(JSON.parse(result1.stdout).ok);
    const marker1 = JSON.parse(readFileSync(resolve(codexHome, ".anticodex-startup-snapshots-ready.json"), "utf8"));
    const fp1 = marker1.sourceFingerprint;

    // Change shared source content
    writeFileSync(resolve(sharedHome, "skills", "demo", "SKILL.md"), "v2");

    // Second run: different fingerprint due to content change
    const result2 = spawnSync(process.execPath, [syncScript, codexHome, sharedHome, "--startup-snapshots"], {
      encoding: "utf8",
    });
    assert.strictEqual(result2.status, 0, result2.stderr || result2.stdout);
    assert.ok(JSON.parse(result2.stdout).ok);
    const marker2 = JSON.parse(readFileSync(resolve(codexHome, ".anticodex-startup-snapshots-ready.json"), "utf8"));
    const fp2 = marker2.sourceFingerprint;

    // Fingerprints must differ because source content changed
    assert.notStrictEqual(fp1, fp2, "sourceFingerprint must change when shared source content changes");

    // Third run with no change: fingerprint must be stable
    const result3 = spawnSync(process.execPath, [syncScript, codexHome, sharedHome, "--startup-snapshots"], {
      encoding: "utf8",
    });
    assert.strictEqual(result3.status, 0, result3.stderr || result3.stdout);
    const marker3 = JSON.parse(readFileSync(resolve(codexHome, ".anticodex-startup-snapshots-ready.json"), "utf8"));
    assert.strictEqual(marker3.sourceFingerprint, fp2, "sourceFingerprint must be stable when shared source is unchanged");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
