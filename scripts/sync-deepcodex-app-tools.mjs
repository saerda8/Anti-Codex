#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const codexHome = process.argv[2] || path.join(os.homedir(), 'Library/Application Support', 'deepcodex', 'codex-home-deepseek-app');
const sharedCodexHome = process.argv[3] || path.join(os.homedir(), '.codex');

const sharedAppsToolsRoot = path.join(sharedCodexHome, 'cache', 'codex_apps_tools');
const sharedConnectorDir = path.join(sharedCodexHome, 'cache', 'codex_app_directory');
const targetCacheRoot = path.join(codexHome, 'cache');
const targetAppsToolsRoot = path.join(targetCacheRoot, 'codex_apps_tools');
const targetConnectorDir = path.join(targetCacheRoot, 'codex_app_directory');
const mirroredPluginsRoot = path.join(codexHome, '.tmp', 'plugins', 'plugins');
const sharedInstalledPluginsRoot = path.join(sharedCodexHome, '.tmp', 'plugins', 'plugins');
const registryPath = path.join(targetCacheRoot, 'deepcodex_app_connectors.json');

function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function safeReadJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function syncDirContents(source, target) {
  ensureDir(target);
  if (!exists(source)) {
    for (const name of fs.readdirSync(target)) {
      fs.rmSync(path.join(target, name), { recursive: true, force: true });
    }
    return [];
  }

  const copied = [];
  const sourceNames = new Set(fs.readdirSync(source));
  for (const name of fs.readdirSync(target)) {
    if (!sourceNames.has(name)) {
      fs.rmSync(path.join(target, name), { recursive: true, force: true });
    }
  }
  for (const name of sourceNames) {
    const sourcePath = path.join(source, name);
    const targetPath = path.join(target, name);
    fs.rmSync(targetPath, { recursive: true, force: true });
    fs.cpSync(sourcePath, targetPath, { recursive: true, force: true, dereference: false });
    copied.push(name);
  }
  return copied.sort();
}

function directoryContentFingerprint(root) {
  if (!exists(root)) return { exists: false, fileCount: 0, fingerprint: null };
  const files = [];
  function walk(current, rel = '') {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === '.anticodex-source-manifest.json') continue;
      const childRel = rel ? path.join(rel, entry.name) : entry.name;
      const childPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(childPath, childRel);
      } else if (entry.isFile()) {
        files.push(childRel);
      }
    }
  }
  walk(root);

  const hash = crypto.createHash('sha256');
  for (const rel of files) {
    hash.update(rel.split(/[\\/]/).join('/'));
    hash.update('\0');
    hash.update(crypto.createHash('sha256').update(fs.readFileSync(path.join(root, rel))).digest('hex'));
    hash.update('\0');
  }
  return {
    exists: true,
    fileCount: files.length,
    fingerprint: hash.digest('hex'),
  };
}

function collectAppEntries(root, sourceLabel, rows, seen) {
  if (!exists(root)) return;
  for (const pluginName of fs.readdirSync(root)) {
    const appJsonPath = path.join(root, pluginName, '.app.json');
    const pluginJsonPath = path.join(root, pluginName, '.codex-plugin', 'plugin.json');
    if (!exists(appJsonPath)) continue;
    const appData = safeReadJson(appJsonPath);
    if (!appData || typeof appData !== 'object' || typeof appData.apps !== 'object' || appData.apps == null) continue;
    const pluginMeta = safeReadJson(pluginJsonPath) || {};
    for (const [appName, meta] of Object.entries(appData.apps)) {
      if (!meta || typeof meta !== 'object') continue;
      const connectorId = typeof meta.id === 'string' ? meta.id : '';
      if (!connectorId) continue;
      const key = `${pluginName}\u0000${appName}\u0000${connectorId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({
        plugin_name: pluginName,
        plugin_display_name: pluginMeta.name || pluginName,
        plugin_marketplace: pluginMeta.marketplace || '',
        plugin_version: pluginMeta.version || '',
        app_name: appName,
        connector_id: connectorId,
        mention: `[$${appName}](app://${connectorId})`,
        source: sourceLabel,
      });
    }
  }
}

ensureDir(targetCacheRoot);
const syncedFiles = syncDirContents(sharedAppsToolsRoot, targetAppsToolsRoot);
const syncedConnectorFiles = syncDirContents(sharedConnectorDir, targetConnectorDir);
const sharedToolsSnapshot = directoryContentFingerprint(sharedAppsToolsRoot);
const localToolsSnapshot = directoryContentFingerprint(targetAppsToolsRoot);
const contentMatches = sharedToolsSnapshot.exists
  ? sharedToolsSnapshot.fileCount === localToolsSnapshot.fileCount
    && sharedToolsSnapshot.fingerprint === localToolsSnapshot.fingerprint
  : localToolsSnapshot.fileCount === 0;

const registryRows = [];
const seen = new Set();
collectAppEntries(sharedInstalledPluginsRoot, 'shared-installed', registryRows, seen);
collectAppEntries(mirroredPluginsRoot, 'mirrored-installed', registryRows, seen);
registryRows.sort((a, b) =>
  a.plugin_name.localeCompare(b.plugin_name)
  || a.app_name.localeCompare(b.app_name)
  || a.connector_id.localeCompare(b.connector_id)
);

fs.writeFileSync(registryPath, JSON.stringify({
  schema_version: 1,
  generated_at: new Date().toISOString(),
  shared_apps_tools_root: sharedAppsToolsRoot,
  mirrored_plugins_root: mirroredPluginsRoot,
  synced_tool_cache_files: syncedFiles,
  shared_tools_file_count: sharedToolsSnapshot.fileCount,
  local_tools_file_count: localToolsSnapshot.fileCount,
  shared_tools_fingerprint: sharedToolsSnapshot.fingerprint,
  local_tools_fingerprint: localToolsSnapshot.fingerprint,
  content_matches: contentMatches,
  connectors: registryRows,
}, null, 2) + '\n');

console.log(`Synced app tool cache files: ${syncedFiles.length}; synced connector cache files: ${syncedConnectorFiles.length}; connectors indexed: ${registryRows.length}; content matches: ${contentMatches ? 'true' : 'false'}`);
