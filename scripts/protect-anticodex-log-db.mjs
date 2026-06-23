#!/usr/bin/env node
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const originalEmitWarning = process.emitWarning.bind(process);
process.emitWarning = (warning, ...args) => {
  const type = typeof args[0] === "string" ? args[0] : "";
  const message = warning instanceof Error ? warning.message : String(warning ?? "");
  if (type === "ExperimentalWarning" && message.includes("SQLite")) return;
  return originalEmitWarning(warning, ...args);
};
const { DatabaseSync } = await import("node:sqlite");

const SELF_TEST_FLAG = "--self-test";
const ALLOW_ANY_CODEX_HOME_FLAG = "--allow-any-codex-home";
const BACKUP_FLAG = "--backup";
const TRIGGER_NAME = "anticodex_drop_trace_logs";
const TRACE_GUARD_SQL = `
CREATE TRIGGER IF NOT EXISTS ${TRIGGER_NAME}
BEFORE INSERT ON logs
WHEN NEW.level = 'TRACE'
BEGIN
  SELECT RAISE(IGNORE);
END`;

function parseArgs(argv) {
  const parsed = {
    args: new Map(),
    flags: new Set(),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const name = arg.slice(2);
    if (arg === SELF_TEST_FLAG || arg === ALLOW_ANY_CODEX_HOME_FLAG || arg === BACKUP_FLAG) {
      parsed.flags.add(name);
      continue;
    }
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for --${name}`);
    parsed.args.set(name, value);
    i += 1;
  }
  return parsed;
}

function defaultAntiCodexHome() {
  const appData = process.env.APPDATA;
  if (!appData) throw new Error("APPDATA is not set; pass --codex-home explicitly");
  return join(appData, "anticodex", "codex-home-deepseek-app");
}

function isSafeAntiCodexHome(codexHome) {
  const resolved = resolve(codexHome).toLowerCase();
  return resolved.includes(`${join("anticodex", "codex-home-deepseek-app").toLowerCase()}`) ||
    (basename(resolved) === "codex-home-deepseek-app" && resolved.includes(`${join("appdata", "roaming", "anticodex").toLowerCase()}`));
}

function getWalSize(dbPath) {
  const walPath = `${dbPath}-wal`;
  if (!existsSync(walPath)) return 0;
  return statSync(walPath).size;
}

function readSnapshot(db, dbPath) {
  const row = db.prepare(`
    SELECT
      COUNT(*) AS count,
      COALESCE(MAX(id), 0) AS maxId,
      SUM(CASE WHEN level = 'TRACE' THEN 1 ELSE 0 END) AS traceCount
    FROM logs
  `).get();
  return {
    count: Number(row?.count ?? 0),
    maxId: Number(row?.maxId ?? 0),
    traceCount: Number(row?.traceCount ?? 0),
    walBytes: getWalSize(dbPath),
  };
}

function hasLogsTable(db) {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'logs'").get();
  return Boolean(row);
}

function hasLevelColumn(db) {
  const rows = db.prepare("PRAGMA table_info(logs)").all();
  return rows.some((row) => row.name === "level");
}

function hasTraceTrigger(db) {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(TRIGGER_NAME);
  return Boolean(row);
}

function backupLogDb(dbPath, backupRoot) {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  const target = join(backupRoot, `logs_2-backup-${stamp}`);
  mkdirSync(target, { recursive: true });
  for (const suffix of ["", "-wal", "-shm"]) {
    const source = `${dbPath}${suffix}`;
    if (existsSync(source)) copyFileSync(source, join(target, `logs_2.sqlite${suffix}`));
  }
  return target;
}

export function protectAntiCodexLogDb(options = {}) {
  const codexHome = options.codexHome ? resolve(options.codexHome) : defaultAntiCodexHome();
  if (!options.allowAnyCodexHome && !isSafeAntiCodexHome(codexHome)) {
    throw new Error(`refusing to protect non-Anti-Codex home: ${codexHome}`);
  }

  const dbPath = options.dbPath ? resolve(options.dbPath) : join(codexHome, "logs_2.sqlite");
  if (basename(dbPath).toLowerCase() !== "logs_2.sqlite") {
    throw new Error(`refusing unexpected log database name: ${dbPath}`);
  }
  if (!existsSync(dbPath)) {
    return { ok: true, skipped: true, reason: "logs_2.sqlite not present", codexHome, dbPath };
  }

  let backupPath = null;
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    if (!hasLogsTable(db)) {
      return { ok: true, skipped: true, reason: "logs table not present", codexHome, dbPath };
    }
    if (!hasLevelColumn(db)) {
      return { ok: false, error: "logs table is missing level column", codexHome, dbPath };
    }

    const before = readSnapshot(db, dbPath);
    const alreadyProtected = hasTraceTrigger(db);
    if (options.backup && !alreadyProtected) {
      backupPath = backupLogDb(dbPath, options.backupRoot ?? join(codexHome, ".anticodex-log-guard-backups"));
    }
    db.exec(TRACE_GUARD_SQL);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const after = readSnapshot(db, dbPath);
    return {
      ok: true,
      skipped: false,
      protected: true,
      trigger: TRIGGER_NAME,
      alreadyProtected,
      backupPath,
      codexHome,
      dbPath,
      before,
      after,
    };
  } finally {
    db.close();
  }
}

function createSelfTestDb(root) {
  mkdirSync(root, { recursive: true });
  const dbPath = join(root, "logs_2.sqlite");
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec(`
      CREATE TABLE logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT,
        ts_nanos INTEGER,
        level TEXT,
        target TEXT,
        feedback_log_body TEXT,
        module_path TEXT,
        file TEXT,
        line INTEGER,
        thread_id TEXT,
        process_uuid TEXT,
        estimated_bytes INTEGER
      )
    `);
    db.prepare("INSERT INTO logs(level, feedback_log_body) VALUES (?, ?)").run("TRACE", "pre-existing trace");
    db.prepare("INSERT INTO logs(level, feedback_log_body) VALUES (?, ?)").run("INFO", "pre-existing info");
  } finally {
    db.close();
  }
  return dbPath;
}

function runSelfTest() {
  const tempRoot = mkdtempSync(join(os.tmpdir(), "anticodex-log-guard-"));
  try {
    const codexHome = join(tempRoot, "codex-home-deepseek-app");
    const dbPath = createSelfTestDb(codexHome);
    const first = protectAntiCodexLogDb({ codexHome, allowAnyCodexHome: true, backup: true, backupRoot: join(tempRoot, "backups") });

    const db = new DatabaseSync(dbPath);
    try {
      const before = readSnapshot(db, dbPath);
      db.prepare("INSERT INTO logs(level, feedback_log_body) VALUES (?, ?)").run("TRACE", "blocked trace");
      db.prepare("INSERT INTO logs(level, feedback_log_body) VALUES (?, ?)").run("INFO", "kept info");
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      const after = readSnapshot(db, dbPath);

      assert.equal(first.ok, true);
      assert.equal(first.protected, true);
      assert.equal(first.alreadyProtected, false);
      assert.ok(first.backupPath && existsSync(first.backupPath), "missing backup path");
      assert.equal(before.traceCount, 1);
      assert.equal(after.traceCount, 1);
      assert.equal(after.count, before.count + 1);
      assert.equal(after.walBytes, 0);
      assert.equal(hasTraceTrigger(db), true);
    } finally {
      db.close();
    }

    const second = protectAntiCodexLogDb({ codexHome, allowAnyCodexHome: true });
    assert.equal(second.ok, true);
    assert.equal(second.alreadyProtected, true);
    return { ok: true, first, second };
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const parsed = parseArgs(process.argv.slice(2));
    const result = parsed.flags.has("self-test")
      ? runSelfTest()
      : protectAntiCodexLogDb({
          codexHome: parsed.args.get("codex-home"),
          dbPath: parsed.args.get("db"),
          allowAnyCodexHome: parsed.flags.has("allow-any-codex-home"),
          backup: parsed.flags.has("backup"),
          backupRoot: parsed.args.get("backup-root"),
        });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`);
    process.exitCode = 1;
  }
}
