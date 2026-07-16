#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const key = process.argv[i];
  if (key === "--help" || key === "-h") {
    console.log(`Usage: node scripts/test-anticodex-legacy-zero-hit.mjs [options]

Options:
  --workspace-root <path>   Expected project root (default: current workspace)
  --report-root <path>      Report output root
  --no-write-report         Print JSON only
  --help, -h                Show this help`);
    process.exit(0);
  }
  if (!key.startsWith("--")) continue;
  const next = process.argv[i + 1];
  if (next && !next.startsWith("--")) {
    args.set(key, next);
    i += 1;
  } else {
    args.set(key, "1");
  }
}

const startedAt = Date.now();
const defaultWorkspaceRoot = resolve(import.meta.dirname, "..");
const workspaceRoot = resolve(args.get("--workspace-root") || defaultWorkspaceRoot);
const reportRoot = resolve(args.get("--report-root") || join(process.env.APPDATA || os.tmpdir(), "anticodex", "reports"));
const noWriteReport = args.has("--no-write-report");

const legacyFilesToDelete = [
  "antigravity-failure-circuit.mjs",
  "antigravity-request-queue.mjs",
  "antigravity-upstream.mjs",
  "translator/adaptive-server.mjs",
  "translator/server.mjs",
  "translator/antigravity-upstream.mjs",
  "translator/upstream-provider.mjs",
  "translator/compat-rules.mjs",
  "translator/codex-native-harness-turn.mjs",
  "translator/codex-native-protocol.mjs",
  "translator/codex-native-sse.mjs",
  "translator/codex-native-compact.mjs",
  "translator/response-history.mjs",
  "translator/tools/registry.mjs",
  "translator/tools/cache_stability_diff.mjs",
  "translator/antigravity-native-harness-upstream.mjs",
  "translator/antigravity-request-registry.mjs",
  "translator/antigravity-request-queue.mjs",
  "translator/antigravity-session-lock.mjs",
  "translator/antigravity-failure-circuit.mjs",
  "translator/antigravity-readiness.mjs",
  "translator/antigravity-account-tracker.mjs",
  "translator/antigravity-model-route-audit.mjs",
  "translator/probe.mjs",
  "scripts/install-deepcodex.ps1",
  "scripts/start-deepcodex.ps1",
  "scripts/start-adaptive-translator.sh",
  "scripts/deepcodex-translator-watch.sh",
  "scripts/start-deepcodex.sh",
  "scripts/install-deepcodex-app.sh",
  "scripts/deepcodex-setup-ui.mjs",
  "scripts/DeepCodexSetup",
  "scripts/DeepCodexSetup.swift",
  "scripts/enable-deepcodex-plugin-unlock.ps1",
  "scripts/apply-deepcodex-brand.ps1",
  "scripts/deepcodex-plugin-unlock-inject.js",
  "scripts/build-macos-dmg.sh",
  "scripts/build-anticodex-fresh-channel-worker-proof-kit.mjs",
  "scripts/build-anticodex-goal-unblock-package.mjs",
  "scripts/open-anticodex-windows-user-settings.ps1",
  "scripts/prepare-anticodex-antigravity-cli-profile.ps1",
  "scripts/start-anticodex-antigravity-cli-login.ps1",
  "scripts/start-anticodex-antigravity-cli-login-windows-user.ps1",
  "scripts/start-anticodex-second-antigravity-account-login.ps1",
  "scripts/test-anticodex-antigravity-account-isolation-status.ps1",
  "scripts/test-anticodex-antigravity-cli-dual-account-lanes.ps1",
  "scripts/test-anticodex-antigravity-cli-isolation.ps1",
  "scripts/test-anticodex-antigravity-cli-real-smoke.ps1",
  "scripts/test-anticodex-antigravity-cli-windows-user-readiness.ps1",
  "scripts/test-anticodex-agentic-capability-matrix.mjs",
  "scripts/test-anticodex-approved-real-run-sequence.mjs",
  "scripts/test-anticodex-cli-transport-boundary.mjs",
  "scripts/test-anticodex-fresh-channel-worker-proof-kit.test.mjs",
  "scripts/test-anticodex-goal-current-usability.test.mjs",
  "scripts/test-anticodex-goal-readiness.mjs",
  "scripts/test-anticodex-goal-real-run-readiness.mjs",
  "scripts/test-anticodex-goal-unblock-package.test.mjs",
  "scripts/test-anticodex-long-task-landing-matrix.mjs",
  "scripts/test-anticodex-native-codex-parity-tasks.mjs",
  "scripts/test-anticodex-provider-antigravity-return.ps1",
  "scripts/test-anticodex-real-approval-plan.mjs",
  "scripts/test-anticodex-real-task-coverage-roadmap.mjs",
  "scripts/test-anticodex-real-third-party-provider.mjs",
  "scripts/test-anticodex-required-real-traffic-sequence.ps1",
  "scripts/test-anticodex-second-account-login-entrypoint.ps1",
  "scripts/test-anticodex-second-account-post-login-proof.ps1",
  "scripts/test-anticodex-second-account-readiness-summary.ps1",
  "scripts/test-anticodex-windows-user-account-prepare.ps1",
  "scripts/test-anticodex-windows-user-setup-guidance.ps1",
  "scripts/test-anticodex-xiaoqiang-current-channel-live-proof.mjs",
  "scripts/test-anticodex-xiaoqiang-mcp.mjs",
  "scripts/test-anticodex-xiaoqiang-usage-ledger.mjs",
  "src/deepcodex-launcher-win.cs",
  "src/deepcodex-launcher.c"
];

const zeroHitBehaviorFamilies = [
  "deterministicArtifact",
  "deterministicTask",
  "artifactMarker",
  "artifactGuard",
  "parsePseudoTool",
  "internalTools",
  "callAntigravityWithInternalTools",
  "implementationRecovery",
  "repeatedReadOnlyInspection",
  "repeatedLaunchCommand",
  "normalizeFullFileBlockPatch",
  "normalizeInlinePathFullReplacementPatch",
  "anchorRelativeCodexPatchPaths",
  "buildAntigravityProtocolPrompt"
];

const legacyFilesToDeleteNorm = legacyFilesToDelete.map(f => f.replace(/\\/g, "/").toLowerCase());

function isProductionSourceFile(filePath, rootDir) {
  const rel = relative(rootDir, filePath);
  const relNorm = rel.replace(/\\/g, "/").toLowerCase();

  // Exclude node_modules, git, docs, audits, tests, fixtures, temp, scratch
  const parts = relNorm.split("/");
  const ignoredSegments = ["node_modules", ".git", "third_party", "docs", "audits", "tests", "test", "fixtures", "temp", "tmp", "scratch", ".gemini"];
  if (parts.some(part => ignoredSegments.includes(part))) {
    return false;
  }

  const filename = basename(filePath).toLowerCase();
  // Skip test files and markdown documentation
  if (filename.startsWith("test-") || filename.includes(".test.")) {
    return false;
  }

  // Exclude the legacy files themselves from scanning
  if (legacyFilesToDeleteNorm.includes(relNorm)) {
    return false;
  }

  // Only check code/script files
  const ext = filename.split(".").pop();
  const validExts = ["mjs", "js", "cjs", "py", "sh", "bat", "ps1", "psm1", "cs", "swift", "c"];
  if (!validExts.includes(ext)) {
    return false;
  }

  return true;
}

function walk(dir, fileList = []) {
  if (!existsSync(dir)) return fileList;
  const files = readdirSync(dir);
  for (const file of files) {
    const filePath = join(dir, file);
    const stat = statSync(filePath);
    if (stat.isDirectory()) {
      const name = basename(filePath);
      // Skip common non-production directories for speed
      if (["node_modules", ".git", "third_party", "docs", "tests", "test", "fixtures", "audits", "scratch", ".gemini"].includes(name)) {
        continue;
      }
      walk(filePath, fileList);
    } else {
      fileList.push(filePath);
    }
  }
  return fileList;
}

function writeTextAtomic(filePath, text, encoding = "utf8") {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, text, encoding);
  renameSync(tmp, filePath);
}

function writeReport(payload) {
  mkdirSync(reportRoot, { recursive: true });
  const stampStr = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
  const latest = join(reportRoot, "latest-legacy-zero-hit.json");
  const history = join(reportRoot, `${stampStr}-legacy-zero-hit.json`);
  const json = `${JSON.stringify(payload, null, 2)}\n`;
  for (const file of [latest, history]) {
    writeTextAtomic(file, json);
    writeTextAtomic(`${file}.sha256`, `sha256:${createHash("sha256").update(json).digest("hex")}`, "ascii");
  }
  return { latest, history };
}

function stripApprovedRemovalLedger(content, relPath) {
  if (relPath !== "scripts/install-anticodex.ps1" && relPath !== "scripts/sync-anticodex-runtime.ps1") {
    return content;
  }
  return content.replace(/\$legacyRuntimeFiles\s*=\s*@\([\s\S]*?\r?\n\)/, "");
}

function main() {
  const existingLegacyFiles = [];
  for (const relPath of legacyFilesToDelete) {
    const fullPath = join(workspaceRoot, relPath);
    if (existsSync(fullPath)) {
      existingLegacyFiles.push(relPath);
    }
  }

  const allFiles = walk(workspaceRoot);
  const prodFiles = allFiles.filter(f => isProductionSourceFile(f, workspaceRoot));

  const legacyFileRegexes = legacyFilesToDelete.map(f => {
    const base = basename(f);
    const escaped = base.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
    return {
      original: f,
      regex: new RegExp(`(?<![\\w-])${escaped}\\b`, "i")
    };
  });

  const behaviorRegexes = zeroHitBehaviorFamilies.map(f => {
    const escaped = f.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
    return {
      original: f,
      regex: new RegExp(`\\b${escaped}\\b`)
    };
  });

  const forbiddenImports = [];
  const forbiddenBehaviors = [];

  for (const file of prodFiles) {
    let content;
    try {
      content = readFileSync(file, "utf8");
    } catch (e) {
      // Ignore unreadable files or log them
      continue;
    }
    const relPath = relative(workspaceRoot, file).replace(/\\/g, "/");
    const activeContent = stripApprovedRemovalLedger(content, relPath);

    for (const { original, regex } of legacyFileRegexes) {
      if (regex.test(activeContent)) {
        forbiddenImports.push({
          file: relPath,
          legacyFile: original
        });
      }
    }

    for (const { original, regex } of behaviorRegexes) {
      if (regex.test(activeContent)) {
        forbiddenBehaviors.push({
          file: relPath,
          behavior: original
        });
      }
    }
  }

  const ok = (existingLegacyFiles.length === 0) && (forbiddenImports.length === 0) && (forbiddenBehaviors.length === 0);

  const payload = {
    ok,
    reportName: "legacy-zero-hit",
    requestedRealTraffic: false,
    usedRealTraffic: false,
    noTraffic: true,
    behaviorCovered: true,
    coverageKind: "legacy-zero-hit-check",
    checkedAt: new Date().toISOString(),
    workspaceRoot,
    legacyFilesExist: existingLegacyFiles,
    forbiddenImports,
    forbiddenBehaviors,
    elapsedMs: Date.now() - startedAt
  };

  if (!noWriteReport) {
    payload.report = writeReport(payload);
  }

  console.log(JSON.stringify(payload));

  if (!ok) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

main();
