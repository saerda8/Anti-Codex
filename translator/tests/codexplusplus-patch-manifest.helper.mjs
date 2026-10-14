import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

export function readCodexPlusPlusPatchManifest(root) {
  const componentRoot = join(root, "third_party", "codexplusplus");
  const metadata = JSON.parse(readFileSync(join(componentRoot, "upstream.json"), "utf8"));
  const patches = (Array.isArray(metadata.patches) ? metadata.patches : []).map((entry) => {
    const file = String(entry.file || "");
    const path = join(componentRoot, file);
    return {
      ...entry,
      file,
      path,
      text: readFileSync(path, "utf8"),
    };
  });
  return {
    componentRoot,
    metadata,
    patches,
    text: patches.map(({ text }) => text).join("\n"),
  };
}

export function readCodexPlusPlusAcceptedSource(root, metadata) {
  const version = sourceIdentityPart(metadata, "version");
  const upstreamCommit = sourceIdentityPart(metadata, "upstreamCommit", /^[0-9a-f]{40}$/);
  const patchCommit = sourceIdentityPart(metadata, "patchCommit", /^[0-9a-f]{40}$/);
  const expectedTree = String(metadata?.verification?.patchReplay || "").match(
    /\btree ([0-9a-f]{40})\b/,
  )?.[1];
  if (!expectedTree) {
    throw acceptedSourceError(metadata, "accepted metadata does not record its replay tree");
  }

  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) {
    throw acceptedSourceError(metadata, "LOCALAPPDATA is unavailable");
  }
  const sourceRoot = resolve(
    localAppData,
    "Anti-Codex",
    "component-sources",
    "codexplusplus",
    "candidates",
    version,
    upstreamCommit,
    patchCommit,
    "source",
  );
  if (!existsSync(sourceRoot)) {
    throw acceptedSourceError(metadata, `source cache is missing at ${sourceRoot}`);
  }

  const head = runGit(sourceRoot, ["rev-parse", "--verify", "HEAD"]);
  if (head !== patchCommit) {
    throw acceptedSourceError(metadata, `source cache HEAD is ${head}, expected ${patchCommit}`);
  }
  const tree = runGit(sourceRoot, ["rev-parse", "--verify", "HEAD^{tree}"]);
  if (tree !== expectedTree) {
    throw acceptedSourceError(metadata, `source cache tree is ${tree}, expected ${expectedTree}`);
  }
  const status = runGit(sourceRoot, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--ignore-submodules=none",
  ]);
  if (status) {
    throw acceptedSourceError(metadata, `source cache worktree is dirty: ${status.split("\n")[0]}`);
  }

  return {
    metadata,
    sourceRoot,
    read(relativePath) {
      const path = resolve(sourceRoot, relativePath);
      const pathFromRoot = relative(sourceRoot, path);
      if (!pathFromRoot || pathFromRoot.startsWith("..") || isAbsolute(pathFromRoot)) {
        throw new Error(`CodexPlusPlus accepted source path escapes its root: ${relativePath}`);
      }
      return readFileSync(path, "utf8").replaceAll("\r\n", "\n");
    },
  };
}

function sourceIdentityPart(metadata, field, pattern = /^[A-Za-z0-9._-]+$/) {
  const value = String(metadata?.[field] || "");
  if (!pattern.test(value)) {
    throw acceptedSourceError(metadata, `accepted metadata has an invalid ${field}`);
  }
  return value;
}

function runGit(sourceRoot, args) {
  const result = spawnSync("git", ["-C", sourceRoot, ...args], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message || result.stderr?.trim() || `git exited ${result.status}`;
    throw new Error(`Cannot verify accepted CodexPlusPlus source cache: ${detail}`);
  }
  return result.stdout.trim();
}

function acceptedSourceError(metadata, detail) {
  const version = String(metadata?.version || "unknown");
  const tag = String(metadata?.tag || `v${version}`);
  return new Error(
    `Accepted CodexPlusPlus source cache for version ${version} is unavailable: ${detail}. `
      + `Prepare accepted version ${version} first with scripts/prepare-codexplusplus-candidate.ps1 -Tag ${tag}.`,
  );
}

export function patchTextContaining(manifest, marker) {
  return manifest.patches
    .filter(({ file, text }) => file.includes(marker) || text.includes(marker))
    .map(({ text }) => text)
    .join("\n");
}

function addedLines(text) {
  return text
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1))
    .join("\n");
}

export function patchHunkContaining(manifest, marker) {
  const hunk = manifest.text
    .split(/(?=^@@ )/m)
    .find((candidate) => candidate.includes(marker));
  return hunk ? addedLines(hunk) : "";
}

export function patchSectionContaining(manifest, marker) {
  const section = manifest.text
    .split(/(?=^diff --git )/m)
    .find((candidate) => candidate.includes(marker));
  return section ? addedLines(section) : "";
}

export function patchAddedLinesContaining(manifest, marker) {
  return patchHunkContaining(manifest, marker);
}

export function patchWindowContaining(manifest, marker, before = 400, after = 2400) {
  const added = manifest.patches
    .map(({ text }) => text.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++" )).map((line) => line.slice(1)).join("\n"))
    .join("\n");
  const index = added.indexOf(marker);
  return index < 0 ? "" : added.slice(Math.max(0, index - before), index + after);
}
