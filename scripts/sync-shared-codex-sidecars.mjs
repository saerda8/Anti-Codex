#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const sourceHome = process.argv[2] || path.join(os.homedir(), ".codex");
const targetHome = process.argv[3] || path.join(os.homedir(), "Library/Application Support/deepcodex/codex-home-deepseek-app");
const sourceConfigPath = process.argv[4] || path.join(sourceHome, "config.toml");
const targetConfigPath = process.argv[5] || path.join(targetHome, "config.toml");

const pluginSectionRe = /^\[plugins\."([^"]+)"\]$/;
const enabledRe = /^enabled\s*=\s*(true|false)\s*$/;
const notifyRe = /^notify\s*=\s*\[(.*)\]\s*$/;

function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

function parseEnabledPluginNames(text) {
  const names = new Set();
  let currentPlugin = null;
  for (const line of text.split(/\r?\n/)) {
    const pluginMatch = line.match(pluginSectionRe);
    if (pluginMatch) {
      const key = pluginMatch[1];
      const at = key.lastIndexOf("@");
      currentPlugin = at > 0 ? key.slice(0, at) : null;
      continue;
    }
    const enabledMatch = line.match(enabledRe);
    if (enabledMatch && currentPlugin) {
      if (enabledMatch[1] === "true") {
        names.add(currentPlugin);
      }
      currentPlugin = null;
      continue;
    }
    if (/^\[[^\]]+\]\s*$/.test(line)) {
      currentPlugin = null;
    }
  }
  return names;
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
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Compute a manifest of all files/directories under dirPath.
 * Each entry records type, hash (for files), and mtimeMs.
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
      // Best-effort cleanup
    }
  }
  return removed;
}

function copyDirectoryContents(sourcePath, targetPath) {
  fs.mkdirSync(targetPath, { recursive: true });
  for (const entry of fs.readdirSync(sourcePath, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const source = path.join(sourcePath, entry.name);
    const target = path.join(targetPath, entry.name);
    if (entry.isDirectory()) {
      copyDirectoryContents(source, target);
    } else if (entry.isSymbolicLink()) {
      try {
        const realSource = fs.realpathSync(source);
        const realStat = fs.statSync(realSource);
        if (realStat.isDirectory()) copyDirectoryContents(realSource, target);
        else fs.copyFileSync(realSource, target);
      } catch {
        // Ignore broken links in shared sidecars; Anti-Codex imports usable files only.
      }
    } else if (entry.isFile()) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
    }
  }
}

function ensureLocalCopy(targetPath, sourcePath) {
  if (!existsOrSymlink(sourcePath)) return false;
  if (isDirectoryLink(targetPath)) {
    fs.rmSync(targetPath, { recursive: true, force: true });
  }

  // Read old manifest for pruning after copy
  const manifestPath = path.join(targetPath, '.anticodex-source-manifest.json');
  let oldManifest = {};
  if (fs.existsSync(manifestPath)) {
    try {
      oldManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch {
      oldManifest = {};
    }
  }

  copyDirectoryContents(sourcePath, targetPath);

  // Write new manifest and prune stale shared entries
  const newManifest = computeSnapshotManifest(sourcePath);
  try {
    fs.writeFileSync(path.join(targetPath, '.anticodex-source-manifest.json'), JSON.stringify(newManifest));
  } catch {
    // non-fatal
  }
  pruneStaleManifestEntries(targetPath, oldManifest, newManifest);

  return true;
}

function syncPluginSidecars(enabledNames) {
  const copied = [];
  for (const name of enabledNames) {
    const sourceDir = path.join(sourceHome, name);
    if (!exists(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
      continue;
    }
    const targetDir = path.join(targetHome, name);
    if (ensureLocalCopy(targetDir, sourceDir)) {
      copied.push(name);
    }
  }
  return copied;
}

function suppressLegacyNotifyLine() {
  if (!exists(targetConfigPath)) {
    return false;
  }
  const targetText = fs.readFileSync(targetConfigPath, "utf8");
  const existingNotifyLines = targetText.split(/\r?\n/).filter((line) => notifyRe.test(line));
  if (existingNotifyLines.length === 1 && /^notify\s*=\s*\[\]\s*$/.test(existingNotifyLines[0])) {
    return false;
  }
  const targetLines = targetText.split(/\r?\n/).filter((line) => !notifyRe.test(line));
  let insertIndex = 0;
  while (insertIndex < targetLines.length
    && targetLines[insertIndex].trim() !== ""
    && !targetLines[insertIndex].trimStart().startsWith("[")) {
    insertIndex += 1;
  }
  targetLines.splice(insertIndex, 0, "notify = []");
  fs.writeFileSync(targetConfigPath, `${targetLines.join("\n").replace(/\n+$/g, "")}\n`);
  return true;
}

if (!exists(targetHome)) {
  fs.mkdirSync(targetHome, { recursive: true });
}

const targetConfigText = exists(targetConfigPath) ? fs.readFileSync(targetConfigPath, "utf8") : "";
const enabledNames = parseEnabledPluginNames(targetConfigText);
const copied = syncPluginSidecars(enabledNames);
const suppressedLegacyNotify = suppressLegacyNotifyLine();

if (copied.length || suppressedLegacyNotify) {
  const parts = [];
  if (copied.length) parts.push(`sidecars=${copied.join(",")}`);
  if (suppressedLegacyNotify) parts.push("legacy-notify=suppressed");
  console.log(`Synced shared Codex sidecars: ${parts.join(" ")}`);
} else {
  console.log("Synced shared Codex sidecars: none");
}
