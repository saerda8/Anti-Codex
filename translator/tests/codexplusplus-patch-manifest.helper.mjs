import { readFileSync } from "node:fs";
import { join } from "node:path";

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
