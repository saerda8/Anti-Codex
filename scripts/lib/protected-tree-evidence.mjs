import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, readlinkSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

export function snapshotProtectedTree(root, options = {}) {
  const rootPath = resolve(root);
  if (!existsSync(rootPath) || !statSync(rootPath).isDirectory()) {
    throw new Error(`Protected root is not a directory: ${rootPath}`);
  }
  const ignored = new Set((options.ignoredPaths || []).map(canonicalPath));
  const entries = [];

  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const path = resolve(directory, entry.name);
      if (ignored.has(canonicalPath(path))) continue;
      const rel = relative(rootPath, path).split(sep).join("/");
      if (entry.isDirectory()) {
        entries.push({ path: rel, type: "directory" });
        walk(path);
      } else if (entry.isFile()) {
        const content = readFileSync(path);
        entries.push({
          path: rel,
          type: "file",
          size: content.length,
          sha256: createHash("sha256").update(content).digest("hex"),
        });
      } else if (entry.isSymbolicLink()) {
        entries.push({ path: rel, type: "symlink", target: readlinkSync(path) });
      } else {
        entries.push({ path: rel, type: "other" });
      }
    }
  };

  walk(rootPath);
  return {
    root: rootPath,
    entries,
    fingerprint: createHash("sha256").update(JSON.stringify(entries)).digest("hex"),
  };
}

export function diffProtectedTreeSnapshots(before, after) {
  const beforeEntries = new Map((before?.entries || []).map((entry) => [entry.path, entry]));
  const afterEntries = new Map((after?.entries || []).map((entry) => [entry.path, entry]));
  const added = [...afterEntries.keys()].filter((path) => !beforeEntries.has(path)).sort();
  const removed = [...beforeEntries.keys()].filter((path) => !afterEntries.has(path)).sort();
  const changed = [...beforeEntries.keys()]
    .filter((path) => afterEntries.has(path) && JSON.stringify(beforeEntries.get(path)) !== JSON.stringify(afterEntries.get(path)))
    .sort();
  return {
    ok: added.length === 0 && removed.length === 0 && changed.length === 0,
    beforeFingerprint: String(before?.fingerprint || ""),
    afterFingerprint: String(after?.fingerprint || ""),
    added,
    removed,
    changed,
  };
}

function canonicalPath(value) {
  const path = resolve(String(value || ""));
  return process.platform === "win32" ? path.toLowerCase() : path;
}
