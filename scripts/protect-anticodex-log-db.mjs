#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
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
const STATUS_FLAG = "--status";
const ALLOW_ANY_CODEX_HOME_FLAG = "--allow-any-codex-home";
const BACKUP_FLAG = "--backup";
const COMPACT_REMOTE_CONTROL_FLAG = "--compact-remote-control-spam";
const TRIGGER_NAME = "anticodex_drop_trace_logs";
const REMOTE_CONTROL_TRIGGER_NAME = "anticodex_drop_remote_control_auth_wait_logs";
const REMOTE_CONTROL_DISABLE_ENV = "CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED";
const REMOTE_CONTROL_TARGET = "codex_app_server_transport::transport::remote_control::websocket";
const REMOTE_CONTROL_AUTH_WAIT_PREFIX = "waiting to resolve remote control preference until authentication is available";
const TRACE_GUARD_SQL = `
CREATE TRIGGER IF NOT EXISTS ${TRIGGER_NAME}
BEFORE INSERT ON logs
WHEN NEW.level = 'TRACE'
BEGIN
  SELECT RAISE(IGNORE);
END`;
const REMOTE_CONTROL_GUARD_SQL = `
CREATE TRIGGER IF NOT EXISTS ${REMOTE_CONTROL_TRIGGER_NAME}
BEFORE INSERT ON logs
WHEN NEW.level = 'INFO'
  AND NEW.target = '${REMOTE_CONTROL_TARGET}'
  AND NEW.feedback_log_body LIKE '${REMOTE_CONTROL_AUTH_WAIT_PREFIX}%'
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
    if (arg === SELF_TEST_FLAG || arg === STATUS_FLAG || arg === ALLOW_ANY_CODEX_HOME_FLAG || arg === BACKUP_FLAG || arg === COMPACT_REMOTE_CONTROL_FLAG) {
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
      SUM(CASE WHEN level = 'TRACE' THEN 1 ELSE 0 END) AS traceCount,
      SUM(CASE
        WHEN level = 'INFO'
          AND target = ?
          AND feedback_log_body LIKE ?
        THEN 1 ELSE 0
      END) AS remoteControlAuthWaitCount
    FROM logs
  `).get(REMOTE_CONTROL_TARGET, `${REMOTE_CONTROL_AUTH_WAIT_PREFIX}%`);
  return {
    count: Number(row?.count ?? 0),
    maxId: Number(row?.maxId ?? 0),
    traceCount: Number(row?.traceCount ?? 0),
    remoteControlAuthWaitCount: Number(row?.remoteControlAuthWaitCount ?? 0),
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

function hasRemoteControlColumns(db) {
  const names = new Set(db.prepare("PRAGMA table_info(logs)").all().map((row) => row.name));
  return names.has("target") && names.has("feedback_log_body");
}

function hasTraceTrigger(db) {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(TRIGGER_NAME);
  return Boolean(row);
}

function hasRemoteControlTrigger(db) {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(REMOTE_CONTROL_TRIGGER_NAME);
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

function writeTextAtomic(filePath, text, encoding = "utf8") {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    writeFileSync(tmp, text, encoding);
    renameSync(tmp, filePath);
  } catch (error) {
    try { rmSync(tmp, { force: true }); } catch {}
    throw error;
  }
}

function writeSignedLogDbGuardReport(reportRoot, status) {
  const root = resolve(reportRoot);
  mkdirSync(root, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  const latest = join(root, "latest-log-db-guard.json");
  const history = join(root, `${stamp}-log-db-guard.json`);
  const payload = {
    ...status,
    reportName: "log-db-guard",
    report: { latest, history },
  };
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  for (const target of [history, latest]) {
    writeTextAtomic(target, text, "utf8");
    const hash = createHash("sha256").update(text).digest("hex");
    writeTextAtomic(`${target}.sha256`, `sha256:${hash}`, "ascii");
  }
  return { latest, history };
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
  if (options.compactRemoteControlSpam && !options.backup) {
    throw new Error("--compact-remote-control-spam requires --backup");
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
    if (!hasRemoteControlColumns(db)) {
      return { ok: false, error: "logs table is missing remote-control guard columns", codexHome, dbPath };
    }

    const before = readSnapshot(db, dbPath);
    const traceTriggerPresent = hasTraceTrigger(db);
    const remoteControlTriggerPresent = hasRemoteControlTrigger(db);
    const alreadyProtected = traceTriggerPresent && remoteControlTriggerPresent;
    if (options.backup && (!alreadyProtected || options.compactRemoteControlSpam)) {
      db.exec("PRAGMA wal_checkpoint(PASSIVE)");
      backupPath = backupLogDb(dbPath, options.backupRoot ?? join(codexHome, ".anticodex-log-guard-backups"));
    }
    db.exec(TRACE_GUARD_SQL);
    db.exec(REMOTE_CONTROL_GUARD_SQL);
    let removedRemoteControlAuthWaitRows = 0;
    if (options.compactRemoteControlSpam) {
      const result = db.prepare(`
        DELETE FROM logs
        WHERE level = 'INFO'
          AND target = ?
          AND feedback_log_body LIKE ?
      `).run(REMOTE_CONTROL_TARGET, `${REMOTE_CONTROL_AUTH_WAIT_PREFIX}%`);
      removedRemoteControlAuthWaitRows = Number(result.changes ?? 0);
    }
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    if (options.compactRemoteControlSpam) {
      db.exec("VACUUM");
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    }
    const after = readSnapshot(db, dbPath);
    return {
      ok: true,
      skipped: false,
      protected: true,
      trigger: TRIGGER_NAME,
      triggers: [TRIGGER_NAME, REMOTE_CONTROL_TRIGGER_NAME],
      remoteControlDisableEnvironment: REMOTE_CONTROL_DISABLE_ENV,
      alreadyProtected,
      compactedRemoteControlSpam: options.compactRemoteControlSpam === true,
      removedRemoteControlAuthWaitRows,
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

export function antiCodexLogDbStatus(options = {}) {
  const codexHome = options.codexHome ? resolve(options.codexHome) : defaultAntiCodexHome();
  if (!options.allowAnyCodexHome && !isSafeAntiCodexHome(codexHome)) {
    throw new Error(`refusing to inspect non-Anti-Codex home: ${codexHome}`);
  }
  const dbPath = options.dbPath ? resolve(options.dbPath) : join(codexHome, "logs_2.sqlite");
  if (basename(dbPath).toLowerCase() !== "logs_2.sqlite") {
    throw new Error(`refusing unexpected log database name: ${dbPath}`);
  }
  const base = {
    reportName: "log-db-guard",
    noTraffic: true,
    usedRealTraffic: false,
    behaviorCovered: true,
    coverageKind: "installed-no-traffic",
    codexHome,
    dbPath,
    exists: existsSync(dbPath),
    logsTable: false,
    levelColumn: false,
    triggerPresent: false,
    traceTriggerPresent: false,
    remoteControlTriggerPresent: false,
    trigger: TRIGGER_NAME,
    triggers: [TRIGGER_NAME, REMOTE_CONTROL_TRIGGER_NAME],
    remoteControlDisableEnvironment: REMOTE_CONTROL_DISABLE_ENV,
    protected: false,
    walBytes: getWalSize(dbPath),
    count: null,
    maxId: null,
    traceCount: null,
    remoteControlAuthWaitCount: null,
  };
  if (!base.exists) {
    return { ...base, ok: false, reason: "logs_2.sqlite not present" };
  }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    base.logsTable = hasLogsTable(db);
    if (!base.logsTable) return { ...base, ok: false, reason: "logs table not present" };
    base.levelColumn = hasLevelColumn(db);
    if (!base.levelColumn) return { ...base, ok: false, reason: "logs table is missing level column" };
    base.traceTriggerPresent = hasTraceTrigger(db);
    base.remoteControlTriggerPresent = hasRemoteControlTrigger(db);
    base.triggerPresent = base.traceTriggerPresent && base.remoteControlTriggerPresent;
    const snapshot = readSnapshot(db, dbPath);
    base.count = snapshot.count;
    base.maxId = snapshot.maxId;
    base.traceCount = snapshot.traceCount;
    base.remoteControlAuthWaitCount = snapshot.remoteControlAuthWaitCount;
    base.walBytes = snapshot.walBytes;
    base.protected = base.triggerPresent;
    return { ...base, ok: base.protected, reason: base.protected ? "" : "required log guard trigger missing" };
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
    db.prepare("INSERT INTO logs(level, target, feedback_log_body) VALUES (?, ?, ?)").run(
      "INFO",
      REMOTE_CONTROL_TARGET,
      `${REMOTE_CONTROL_AUTH_WAIT_PREFIX} error=API key auth is not supported`,
    );
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
      db.prepare("INSERT INTO logs(level, target, feedback_log_body) VALUES (?, ?, ?)").run(
        "INFO",
        REMOTE_CONTROL_TARGET,
        `${REMOTE_CONTROL_AUTH_WAIT_PREFIX} error=blocked duplicate`,
      );
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      const after = readSnapshot(db, dbPath);

      assert.equal(first.ok, true);
      assert.equal(first.protected, true);
      assert.equal(first.alreadyProtected, false);
      assert.ok(first.backupPath && existsSync(first.backupPath), "missing backup path");
      assert.equal(before.traceCount, 1);
      assert.equal(before.remoteControlAuthWaitCount, 1);
      assert.equal(after.traceCount, 1);
      assert.equal(after.remoteControlAuthWaitCount, 1);
      assert.equal(after.count, before.count + 1);
      assert.equal(after.walBytes, 0);
      assert.equal(hasTraceTrigger(db), true);
      assert.equal(hasRemoteControlTrigger(db), true);
    } finally {
      db.close();
    }

    const second = protectAntiCodexLogDb({ codexHome, allowAnyCodexHome: true });
    assert.equal(second.ok, true);
    assert.equal(second.alreadyProtected, true);
    const compacted = protectAntiCodexLogDb({
      codexHome,
      allowAnyCodexHome: true,
      backup: true,
      backupRoot: join(tempRoot, "compact-backups"),
      compactRemoteControlSpam: true,
    });
    assert.equal(compacted.removedRemoteControlAuthWaitRows, 1);
    assert.equal(compacted.after.remoteControlAuthWaitCount, 0);
    assert.equal(compacted.after.walBytes, 0);
    assert.ok(compacted.backupPath && existsSync(compacted.backupPath), "missing compaction backup path");
    const status = antiCodexLogDbStatus({ codexHome, allowAnyCodexHome: true });
    assert.equal(status.ok, true);
    assert.equal(status.protected, true);
    assert.equal(status.triggerPresent, true);
    assert.equal(status.remoteControlTriggerPresent, true);
    assert.equal(status.remoteControlAuthWaitCount, 0);
    assert.equal(status.walBytes, 0);
    assert.equal(status.usedRealTraffic, false);
    return { ok: true, first, second, status };
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const parsed = parseArgs(process.argv.slice(2));
    const result = parsed.flags.has("self-test")
      ? runSelfTest()
      : parsed.flags.has("status")
        ? (() => {
          const status = antiCodexLogDbStatus({
            codexHome: parsed.args.get("codex-home"),
            dbPath: parsed.args.get("db"),
            allowAnyCodexHome: parsed.flags.has("allow-any-codex-home"),
          });
          const reportRoot = parsed.args.get("report-root");
          if (reportRoot) status.report = writeSignedLogDbGuardReport(reportRoot, status);
          return status;
        })()
      : protectAntiCodexLogDb({
          codexHome: parsed.args.get("codex-home"),
          dbPath: parsed.args.get("db"),
          allowAnyCodexHome: parsed.flags.has("allow-any-codex-home"),
          backup: parsed.flags.has("backup"),
          backupRoot: parsed.args.get("backup-root"),
          compactRemoteControlSpam: parsed.flags.has("compact-remote-control-spam"),
        });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`);
    process.exitCode = 1;
  }
}
