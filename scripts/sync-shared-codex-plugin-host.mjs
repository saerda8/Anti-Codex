#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const codexHome = process.argv[2] || path.join(os.homedir(), 'Library/Application Support', 'deepcodex', 'codex-home-deepseek-app');
const sharedCodexHome = process.argv[3] || path.join(os.homedir(), '.codex');
const skillsOnly = process.argv.includes('--skills-only');
const localSnapshotsOnly = process.argv.includes('--local-snapshots');
const startupSnapshotsOnly = process.argv.includes('--startup-snapshots');
const printStartupSourceFingerprint = process.argv.includes('--print-startup-source-fingerprint');
const syncLockPath = path.join(codexHome, '.sync-shared-codex-plugin-host.lock');
const syncLockStaleMs = Number(process.env.ANTICODEX_SNAPSHOT_LOCK_STALE_MS || 60 * 1000);
const staleArtifactMs = Number(process.env.ANTICODEX_SNAPSHOT_ARTIFACT_STALE_MS || 24 * 60 * 60 * 1000);
const startupSnapshotMarkerPath = path.join(codexHome, '.anticodex-startup-snapshots-ready.json');
const extraSkillsRoots = (process.env.ANTICODEX_EXTRA_SKILLS_ROOTS || path.join(os.homedir(), '.agents', 'skills'))
  .split(path.delimiter)
  .map((item) => item.trim())
  .filter(Boolean);

const sharedMappings = [
  { relPath: 'skills', sharedPath: path.join(sharedCodexHome, 'skills'), extraSharedPaths: extraSkillsRoots, mode: 'copy' },
  { relPath: 'AGENTS.md', sharedPath: path.join(sharedCodexHome, 'AGENTS.md'), mode: 'copy-file' },
  { relPath: 'DEFAULT_SKILL_ALLOWLIST.md', sharedPath: path.join(sharedCodexHome, 'DEFAULT_SKILL_ALLOWLIST.md'), mode: 'copy-file' },
  { relPath: 'RTK.md', sharedPath: path.join(sharedCodexHome, 'RTK.md'), mode: 'copy-file' },
  { relPath: 'MCP_WORKER_USAGE_GUIDE.md', sharedPath: path.join(sharedCodexHome, 'MCP_WORKER_USAGE_GUIDE.md'), mode: 'copy-file' },
  { relPath: path.join('cache', 'codex_app_directory'), sharedPath: path.join(sharedCodexHome, 'cache', 'codex_app_directory'), mode: 'copy' },
  { relPath: 'plugins', sharedPath: path.join(sharedCodexHome, 'plugins'), mode: 'copy' },
  { relPath: path.join('.tmp', 'plugins'), sharedPath: path.join(sharedCodexHome, '.tmp', 'plugins'), mode: 'copy' },
  { relPath: path.join('cache', 'codex_apps_tools'), sharedPath: path.join(sharedCodexHome, 'cache', 'codex_apps_tools'), mode: 'copy' },
  { relPath: 'computer-use', sharedPath: path.join(sharedCodexHome, 'computer-use'), mode: 'copy' },
];
const startupSnapshotMappings = sharedMappings.filter(item => (
  item.relPath === 'skills'
  || item.mode === 'copy-file'
  || item.relPath === path.join('cache', 'codex_app_directory')
  || item.relPath === path.join('cache', 'codex_apps_tools')
));
const mappings = skillsOnly
  ? sharedMappings.filter(item => item.relPath === 'skills')
  : startupSnapshotsOnly
    ? startupSnapshotMappings
  : localSnapshotsOnly
    ? sharedMappings.filter(item => item.mode.startsWith('copy'))
    : sharedMappings;

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function existsOrSymlink(p) {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function isDirectoryLink(p) {
  try {
    const stat = fs.lstatSync(p);
    return stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function isLocalDirectory(p) {
  try {
    const stat = fs.lstatSync(p);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function hasDirectoryEntries(p) {
  try {
    return fs.readdirSync(p).length > 0;
  } catch {
    return false;
  }
}

function copyDirectoryContents(sourcePath, targetPath) {
  ensureDir(targetPath);
  for (const entry of fs.readdirSync(sourcePath, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const source = path.join(sourcePath, entry.name);
    const target = path.join(targetPath, entry.name);
    if (entry.isDirectory()) {
      if (existsOrSymlink(target) && (!fs.lstatSync(target).isDirectory() || fs.lstatSync(target).isSymbolicLink())) {
        fs.rmSync(target, { recursive: true, force: true });
      }
      copyDirectoryContents(source, target);
    } else if (entry.isSymbolicLink()) {
      try {
        const realSource = fs.realpathSync(source);
        const realStat = fs.statSync(realSource);
        if (existsOrSymlink(target)) {
          const targetStat = fs.lstatSync(target);
          const typeMatches = realStat.isDirectory()
            ? targetStat.isDirectory() && !targetStat.isSymbolicLink()
            : targetStat.isFile() && !targetStat.isSymbolicLink();
          if (!typeMatches) fs.rmSync(target, { recursive: true, force: true });
        }
        if (realStat.isDirectory()) copyDirectoryContents(realSource, target);
        else fs.copyFileSync(realSource, target);
      } catch {
        // Ignore broken skill symlinks; the source Codex install can keep them, but
        // Anti-Codex should still import the rest of the usable local skills.
      }
    } else if (entry.isFile()) {
      ensureDir(path.dirname(target));
      if (existsOrSymlink(target) && (!fs.lstatSync(target).isFile() || fs.lstatSync(target).isSymbolicLink())) {
        fs.rmSync(target, { recursive: true, force: true });
      }
      fs.copyFileSync(source, target);
    }
  }
}

function tempId() {
  return crypto.randomUUID().slice(0, 8);
}

/**
 * Compute a manifest of all files/directories under dirPath.
 * Each entry records type, hash (for files), and mtimeMs.
 * Hidden `.anticodex-*` manifest files are excluded.
 */
function computeSnapshotManifest(dirPath) {
  const manifest = {};
  if (!fs.existsSync(dirPath)) return manifest;

  function walk(currentPath, relPath) {
    for (const entry of fs.readdirSync(currentPath, { withFileTypes: true })) {
      if (entry.name === '.anticodex-source-manifest.json') continue;
      const fullPath = path.join(currentPath, entry.name);
      const entryRelPath = relPath ? path.join(relPath, entry.name) : entry.name;
      if (entry.isDirectory()) {
        manifest[entryRelPath] = { type: 'directory', mtimeMs: fs.statSync(fullPath).mtimeMs };
        walk(fullPath, entryRelPath);
      } else if (entry.isFile()) {
        const content = fs.readFileSync(fullPath);
        const hash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
        manifest[entryRelPath] = { type: 'file', hash, mtimeMs: fs.statSync(fullPath).mtimeMs };
      }
    }
  }
  walk(dirPath, '');
  return manifest;
}

function computeCombinedSnapshotManifest(dirPaths) {
  return Object.assign({}, ...dirPaths
    .filter((dirPath) => fs.existsSync(dirPath))
    .map((dirPath) => computeSnapshotManifest(dirPath)));
}

/**
 * Compute a single fingerprint from a manifest, suitable for detecting
 * any content change in the source tree.
 */
function computeSourceFingerprint(manifest) {
  const entries = Object.entries(manifest)
    .filter(([, v]) => v.type === 'file')
    .sort(([a], [b]) => a.localeCompare(b));
  const hash = crypto.createHash('sha256');
  for (const [relPath, entry] of entries) {
    hash.update(relPath);
    hash.update(entry.hash);
  }
  return hash.digest('hex').slice(0, 32);
}

function computeStartupSourceFingerprint() {
  let sourceMtimeMax = null;
  let maxMtime = 0;
  const fp = crypto.createHash('sha256');

  for (const { relPath, sharedPath, extraSharedPaths = [] } of startupSnapshotMappings) {
    const sourcePaths = [sharedPath, ...extraSharedPaths].filter((item) => fs.existsSync(item));
    if (sourcePaths.length === 0) continue;
    fp.update(relPath);
    for (const sourcePath of sourcePaths) {
      const sourceStat = fs.statSync(sourcePath);
      fp.update(sourcePath);
      if (sourceStat.isFile()) {
        fp.update('file');
        fp.update(crypto.createHash('sha256').update(fs.readFileSync(sourcePath)).digest('hex'));
        if (sourceStat.mtimeMs > maxMtime) maxMtime = sourceStat.mtimeMs;
      } else if (sourceStat.isDirectory()) {
        const manifest = computeSnapshotManifest(sourcePath);
        for (const [entryPath, entry] of Object.entries(manifest).sort()) {
          fp.update(entryPath);
          fp.update(entry.type);
          if (entry.hash) fp.update(entry.hash);
          if (entry.mtimeMs > maxMtime) maxMtime = entry.mtimeMs;
        }
      }
    }
  }

  if (maxMtime > 0) sourceMtimeMax = new Date(maxMtime).toISOString();
  return {
    sourceFingerprint: fp.digest('hex').slice(0, 32),
    sourceMtimeMax,
  };
}

/**
 * Prune entries from targetPath that exist in oldManifest but not
 * in newManifest. Entries not tracked by either manifest (local-only)
 * are preserved.
 */
function pruneStaleManifestEntries(targetPath, oldManifest, newManifest) {
  const removed = [];
  for (const [relPath] of Object.entries(oldManifest)) {
    if (newManifest[relPath]) continue;
    const stalePath = path.join(targetPath, relPath);
    try {
      if (fs.existsSync(stalePath)) {
        fs.rmSync(stalePath, { recursive: true, force: true });
        removed.push(relPath);
      }
    } catch {
      // Best-effort cleanup; do not fail the entire sync for one stale entry
    }
  }
  return removed;
}

function acquireSyncLock() {
  ensureDir(codexHome);
  const token = `${process.pid}:${Date.now()}:${crypto.randomUUID()}`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(syncLockPath, token, { flag: 'wx' });
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try {
          if (fs.readFileSync(syncLockPath, 'utf8') === token) fs.rmSync(syncLockPath, { force: true });
        } catch {}
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      try {
        const ageMs = Date.now() - fs.statSync(syncLockPath).mtimeMs;
        if (ageMs > syncLockStaleMs) {
          fs.rmSync(syncLockPath, { force: true });
          continue;
        }
      } catch {}
      throw new Error('Another Anti-Codex local snapshot refresh is already running.');
    }
  }
  throw new Error('Unable to acquire the Anti-Codex local snapshot refresh lock.');
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function cleanupStaleSwapArtifactsForTarget(targetPath) {
  const dir = path.dirname(targetPath);
  if (!fs.existsSync(dir)) return [];
  const base = path.basename(targetPath);
  const artifactNamePattern = new RegExp(`^${escapeRegExp(base)}\\.(?:tmp|old)-[0-9a-f]{8}$`, 'i');
  const removed = [];
  for (const entry of fs.readdirSync(dir)) {
    if (!artifactNamePattern.test(entry)) continue;
    const artifactPath = path.join(dir, entry);
    try {
      const ageMs = Date.now() - fs.lstatSync(artifactPath).mtimeMs;
      if (ageMs < staleArtifactMs) continue;
      fs.rmSync(artifactPath, { recursive: true, force: true });
      removed.push(path.relative(codexHome, artifactPath));
    } catch {}
  }
  return removed;
}

function cleanupStaleSwapArtifacts() {
  return mappings.flatMap(({ relPath }) => cleanupStaleSwapArtifactsForTarget(path.join(codexHome, relPath)));
}

/**
 * Transactionally refresh a directory at targetPath:
 * 1. Build content in a sibling temp directory (existing target content as base,
 *    overlaid with shared source).
 * 2. Atomic rename-swap into place.
 * 3. On swap failure, restore original target.
 * 4. Clean up all temp/old paths.
 * 5. When trackManifest is true, write a source content manifest and prune
 *    entries that were in the previous source manifest but are no longer
 *    present in the shared source (i.e. deleted from the shared Codex).
 */
function syncDirectoryTransactional(sharedPath, targetPath, trackManifest = false, extraSharedPaths = []) {
  const id = tempId();
  const tmpDir = targetPath + '.tmp-' + id;
  const oldDir = targetPath + '.old-' + id;
  const manifestPath = path.join(targetPath, '.anticodex-source-manifest.json');

  // Read old manifest before sync (for pruning after the swap)
  let oldManifest = {};
  if (trackManifest && fs.existsSync(manifestPath)) {
    try {
      oldManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch {
      oldManifest = {};
    }
  }

  try {
    // Build temp directory with existing target content as base
    ensureDir(tmpDir);
    if (existsOrSymlink(targetPath) && !isDirectoryLink(targetPath)) {
      // Preserve local-only files already in target
      copyDirectoryContents(targetPath, tmpDir);
    }

    // Overlay shared sources (later sources win for conflicting entries).
    for (const sourcePath of [sharedPath, ...extraSharedPaths].filter((item) => fs.existsSync(item))) {
      copyDirectoryContents(sourcePath, tmpDir);
    }

    // Move existing target out of the way
    if (existsOrSymlink(targetPath)) {
      try {
        fs.renameSync(targetPath, oldDir);
      } catch (renameErr) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        throw new Error(
          `Failed to move existing target aside before swap: ${renameErr.message}`
        );
      }
    }

    // Atomic swap: temp directory becomes the new target
    try {
      fs.renameSync(tmpDir, targetPath);
    } catch (renameErr) {
      // Swap failed; restore original target if possible.
      if (existsOrSymlink(oldDir) && !existsOrSymlink(targetPath)) {
        try { fs.renameSync(oldDir, targetPath); } catch (e) { /* best effort */ }
      }
      if (existsOrSymlink(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
      throw new Error(
        `Failed to swap temporary directory into place: ${renameErr.message}`
      );
    }

    // Cleanup old backup directory
    if (existsOrSymlink(oldDir)) {
      fs.rmSync(oldDir, { recursive: true, force: true });
    }

    // After successful swap: write new manifest and prune stale shared entries
    if (trackManifest) {
      const newManifest = computeCombinedSnapshotManifest([sharedPath, ...extraSharedPaths]);
      try {
        fs.writeFileSync(path.join(targetPath, '.anticodex-source-manifest.json'), JSON.stringify(newManifest));
      } catch {
        // Manifest write failure is non-fatal; the next sync will recompute
      }
      pruneStaleManifestEntries(targetPath, oldManifest, newManifest);
    }
  } finally {
    // Safety net: if temp dir somehow still exists (e.g. error after rename),
    // clean it up
    if (existsOrSymlink(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }
}

/**
 * Transactionally refresh a single file at targetPath:
 * 1. Write to a sibling temp file.
 * 2. Atomic rename into place.
 * 3. On failure, clean up temp file.
 */
function syncFileTransactional(sharedPath, targetPath) {
  const id = tempId();
  const tmpFile = targetPath + '.tmp-' + id;
  const oldFile = targetPath + '.old-' + id;

  try {
    fs.copyFileSync(sharedPath, tmpFile);
    if (existsOrSymlink(targetPath)) {
      fs.renameSync(targetPath, oldFile);
    }
    try {
      fs.renameSync(tmpFile, targetPath);
    } catch (error) {
      if (existsOrSymlink(oldFile) && !existsOrSymlink(targetPath)) {
        try { fs.renameSync(oldFile, targetPath); } catch {}
      }
      throw error;
    }
    if (existsOrSymlink(oldFile)) {
      fs.rmSync(oldFile, { recursive: true, force: true });
    }
  } catch (error) {
    if (existsOrSymlink(tmpFile)) {
      try { fs.rmSync(tmpFile, { recursive: true, force: true }); } catch {}
    }
    throw error;
  }
}

function writeStartupSnapshotMarker(summary) {
  ensureDir(path.dirname(startupSnapshotMarkerPath));

  // Compute a content fingerprint from the shared source to detect
  // when the source has changed since the last marker write.
  let sourceFingerprint = null;
  let sourceMtimeMax = null;
  try {
    ({ sourceFingerprint, sourceMtimeMax } = computeStartupSourceFingerprint());
  } catch {
    // Fingerprint is best-effort; marker is still valid without it
  }

  const marker = {
    schema: 'anticodex-startup-snapshots-ready-v1',
    updatedAt: new Date().toISOString(),
    codexHome,
    sharedCodexHome,
    relPaths: startupSnapshotMappings.map(item => item.relPath),
    summary,
    sourceFingerprint,
    sourceMtimeMax,
  };
  fs.writeFileSync(startupSnapshotMarkerPath, JSON.stringify(marker, null, 2));
}

if (printStartupSourceFingerprint) {
  const fingerprint = computeStartupSourceFingerprint();
  console.log(JSON.stringify({
    ok: true,
    codexHome,
    sharedCodexHome,
    ...fingerprint,
  }, null, 2));
  process.exit(0);
}

const releaseSyncLock = acquireSyncLock();
process.once('exit', releaseSyncLock);

const summary = [];
const cleanup = cleanupStaleSwapArtifacts();
for (const { relPath, sharedPath, extraSharedPaths = [], mode } of mappings) {
  const targetPath = path.join(codexHome, relPath);
  if (mode === 'copy-file') {
    if (!fs.existsSync(sharedPath)) {
      summary.push({ relPath, mode: 'missing-shared-target', target: sharedPath });
      continue;
    }
    ensureDir(path.dirname(targetPath));
    try {
      syncFileTransactional(sharedPath, targetPath);
      summary.push({
        relPath,
        mode: 'copied-file',
        target: sharedPath,
      });
    } catch (error) {
      summary.push({
        relPath,
        mode: 'copy-failed',
        target: sharedPath,
        error: error?.message || String(error),
      });
    }
    continue;
  }
  if (mode === 'copy') {
    const existingExtraSharedPaths = extraSharedPaths.filter((item) => fs.existsSync(item));
    if (!fs.existsSync(sharedPath) && existingExtraSharedPaths.length === 0) {
      summary.push({ relPath, mode: 'missing-shared-target', target: sharedPath, extraTargets: extraSharedPaths });
      continue;
    }
    ensureDir(path.dirname(targetPath));
    if (startupSnapshotsOnly && isLocalDirectory(targetPath) && hasDirectoryEntries(targetPath)) {
      summary.push({ relPath, mode: 'kept-existing-startup-snapshot', target: sharedPath });
      continue;
    }
    try {
      syncDirectoryTransactional(sharedPath, targetPath, true, existingExtraSharedPaths);
      summary.push({
        relPath,
        mode: 'copied',
        target: sharedPath,
        extraTargets: existingExtraSharedPaths,
      });
    } catch (error) {
      summary.push({
        relPath,
        mode: 'copy-failed',
        target: sharedPath,
        error: error?.message || String(error),
      });
    }
    continue;
  }
}

if ((startupSnapshotsOnly || localSnapshotsOnly) && !summary.some(item => item.mode === 'copy-failed')) {
  try {
    writeStartupSnapshotMarker(summary);
  } catch (error) {
    summary.push({
      relPath: path.basename(startupSnapshotMarkerPath),
      mode: 'marker-write-failed',
      error: error?.message || String(error),
    });
  }
}

console.log(JSON.stringify({
  ok: !summary.some(item => item.mode === 'copy-failed' || item.mode === 'marker-write-failed'),
  codexHome,
  sharedCodexHome,
  cleanup,
  summary,
}, null, 2));
releaseSyncLock();
