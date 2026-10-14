import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { readCodexPlusPlusPatchManifest } from "./codexplusplus-patch-manifest.helper.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const componentRoot = join(root, "third_party", "codexplusplus");
const proposalRoot = join(root, "docs", "audits", "codexplusplus", "v1.2.46-source-replay");
const proposalPath = join(proposalRoot, "source-replay.json");
const patchManifest = readCodexPlusPlusPatchManifest(root);

test("current promotion targets the reviewed upstream tag and manifest patch set", () => {
  const accepted = patchManifest.metadata;

  assert.equal(accepted.version, "1.7.1");
  assert.equal(accepted.tag, "v1.7.1");
  assert.equal(accepted.upstreamCommit, "5fe25892eb312abbc091512565a8dc2621a8c999");
  assert.equal(accepted.patchCommit, "c47a056083fe92782e7aca7502d93351ac96ed4d");
  assert.deepEqual(accepted.patches.map(({ file }) => file), [
    "patches/0001-v171-app-path-isolation.patch",
    "patches/0002-v171-state-dir-isolation.patch",
    "patches/0003-v171-launcher-isolation-check.patch",
    "patches/0004-v171-bridge-quota-gate.patch",
    "patches/0005-v171-protocol-compatibility-merge.patch",
    "patches/0006-v171-isolation-blockers.patch",
    "patches/0007-v171-final-isolation-and-session-headers.patch",
    "patches/0008-v171-rustfmt-normalization.patch",
    "patches/0009-v171-isolation-audit-contract-marker.patch",
    "patches/0010-v171-native-contracts.patch",
    "patches/0011-v171-bytes-dependency.patch",
    "patches/0012-v171-lockfile-bytes.patch",
    "patches/0013-v171-response-history.patch",
    "patches/0014-v171-downstream-cancellation.patch",
  ]);
  assert.equal(patchManifest.patches.length, accepted.patches.length);
  for (const patch of patchManifest.patches) {
    assert.match(patch.file, /^patches[\\/]/);
    assert.equal(
      createHash("sha256").update(readFileSync(patch.path)).digest("hex"),
      patch.sha256,
      patch.file,
    );
  }
  assert.match(accepted.verification.patchReplay, /14 project patches/);
  assert.match(accepted.verification.patchReplay, new RegExp(accepted.patchCommit));
  assert.match(accepted.verification.patchReplay, /tree [0-9a-f]{40}$/);
  assert.match(accepted.verification.launcherReleaseBuild, /^sha256:[0-9a-f]{64}$/);
});

function normalizedTextSha256(path) {
  const normalized = readFileSync(path, "utf8").replaceAll("\r\n", "\n");
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

test("historical v1.2.46 source replay remains internally consistent", () => {
  const proposal = JSON.parse(readFileSync(proposalPath, "utf8"));

  assert.deepEqual(Object.keys(proposal).sort(), [
    "accepted",
    "baseAccepted",
    "candidatePublished",
    "component",
    "installEligible",
    "license",
    "replay",
    "repository",
    "schema",
    "securityReview",
    "target",
    "verification",
  ]);
  assert.equal(proposal.schema, "codexplusplus-source-replay-v1");
  assert.equal(proposal.component, "CodexPlusPlus");
  assert.equal(proposal.repository, "https://github.com/BigPizzaV3/CodexPlusPlus.git");
  assert.equal(proposal.license, "AGPL-3.0-only");
  assert.equal(proposal.accepted, false);
  assert.equal(proposal.candidatePublished, false);
  assert.equal(proposal.installEligible, false);

  assert.deepEqual(proposal.baseAccepted, {
    metadataPath: "../../../../third_party/codexplusplus/upstream.json",
    metadataNormalizedSha256: "82ffb795961003a1851a83d257c4cde6e886f5ae7ab742f6851406dc2f659bd2",
    version: "1.2.45",
    tag: "v1.2.45",
    upstreamCommit: "055302664af09e6e3bb76a00b36d318132094ee3",
    patchCommit: "65cbc08be3dc7390bdd61f9236d6c266b61d3f40",
    patchCount: 12,
  });
  assert.deepEqual(proposal.target, {
    version: "1.2.46",
    tag: "v1.2.46",
    upstreamCommit: "a30b550135fb678bab600da59af153a403b285ee",
  });

  assert.equal(proposal.replay.patchCount, 13);
  assert.equal(proposal.replay.acceptedPatchFilesChanged, false);
  assert.equal(proposal.replay.isolationPatchCommit, "d8082c26f116761de89a2ef3342057d54a9e1eb6");
  assert.equal(proposal.replay.patchCommit, "d84bd4274ec72ce1f5347731cdfe5a11c8761469");
  assert.equal(proposal.replay.patchTree, "8037e005b80a2fb09c7784b02bbd8c0889156316");
  assert.deepEqual(proposal.replay.additionalPatches, [{
    file: "patches/0013-fix-format-dreamskin-installer-test.patch",
    normalizedSha256: "2b8303ac87d9d3c4f6b2abb218c836050002f452401093e633d3b6686fbb7811",
    scope: "normalize only the upstream v1.2.46 DreamSkin installer metadata assertion required by stable rustfmt; runtime behavior is unchanged",
  }]);
  const patchPath = join(proposalRoot, proposal.replay.additionalPatches[0].file);
  assert.equal(existsSync(patchPath), true);
  assert.equal(
    normalizedTextSha256(patchPath),
    proposal.replay.additionalPatches[0].normalizedSha256,
  );

  assert.deepEqual(proposal.verification, {
    patchReplay: "passed",
    cargoMetadataLocked: "passed",
    cargoFmt: "passed",
    sourceIsolationAudit: "passed",
    managedBuild: "not_run",
    windowsLaunchability: "not_run",
    dockerUsed: false,
    providerTrafficUsed: false,
    activated: false,
  });
  assert.equal(proposal.securityReview.antiHelperOnlyBoundary, "passed");
  assert.deepEqual(
    proposal.securityReview.upstreamManagerFindings.map(({ severity, id, scope, status }) => ({ severity, id, scope, status })),
    [
      {
        severity: "P1",
        id: "provider-import-confirmation-race",
        scope: "upstream-manager-only",
        status: "open-upstream",
      },
      {
        severity: "P2",
        id: "dreamskin-confirmation-race",
        scope: "upstream-manager-only",
        status: "open-upstream",
      },
      {
        severity: "P2",
        id: "dreamskin-publisher-replacement",
        scope: "upstream-manager-only",
        status: "open-upstream",
      },
    ],
  );
  const providerImportFinding = proposal.securityReview.upstreamManagerFindings[0];
  assert.equal(providerImportFinding.presentInAcceptedBaseVersion, "1.2.45");
  assert.match(providerImportFinding.summary, /displayed provider import.*later import/i);
  assert.match(providerImportFinding.summary, /helper-only mode does not enter/i);
  assert.equal("launcherReleaseBuild" in proposal.verification, false);
  assert.equal("binarySha256" in proposal, false);
  assert.equal("candidateRoot" in proposal, false);
});

test("source replay evidence cannot enter runtime sync or component installation", () => {
  const runtimeSync = readFileSync(join(root, "scripts", "sync-anticodex-runtime.ps1"), "utf8");
  const componentInstall = readFileSync(join(root, "scripts", "install-codexplusplus-component.ps1"), "utf8");
  const releaseGate = readFileSync(join(root, "scripts", "test-anticodex-release-gates.mjs"), "utf8");

  const copiedDirectoriesMatch = runtimeSync.match(
    /foreach \(\$dir in @\((?<body>[^)]*)\)\) \{\s*Copy-AntiCodexRuntimeTree/s,
  );
  assert.ok(copiedDirectoriesMatch);
  const copiedDirectories = [...copiedDirectoriesMatch.groups.body.matchAll(/"([^"]+)"/g)]
    .map((match) => match[1]);
  assert.deepEqual(copiedDirectories, [
    "scripts",
    "translator",
    "assets",
    "codex-home-deepseek-app",
    "third_party",
  ]);

  const publicDocsMatch = runtimeSync.match(
    /\$publicDocFiles\s*=\s*@\((?<body>[\s\S]*?)\n\s*\)/,
  );
  assert.ok(publicDocsMatch);
  const publicDocs = [...publicDocsMatch.groups.body.matchAll(/"([^"]+)"/g)]
    .map((match) => match[1].replaceAll("\\", "/"));
  assert.equal(
    publicDocs.includes("docs/audits/codexplusplus/v1.2.46-source-replay/source-replay.json"),
    false,
  );

  for (const source of [componentInstall, releaseGate]) {
    assert.doesNotMatch(source, /source-replay|v1\.2\.46-source-replay/);
  }
});

test("component documentation records the accepted promotion", () => {
  const readme = readFileSync(join(componentRoot, "README.md"), "utf8");

  assert.match(readme, /Accepted version: `v\d+\.\d+\.\d+`/);
  assert.match(readme, /Accepted commit: `[0-9a-f]{40}`/);
  assert.match(readme, /manifest|cumulative|compatibility patch/i);
  assert.match(readme, /120 seconds without upstream data/);
  assert.match(readme, /one `insufficient_quota` event instead of native reconnects/);
  assert.match(readme, /historical source-replay record/);
  assert.match(readme, /candidate-local build and Windows launchability checks passed/);
  assert.doesNotMatch(readme, /Version: `v1\.2\.44`/);
  assert.doesNotMatch(readme, /checkout 77091ccaee4423f35a1b2c51c4ecd703e6201092/);
});
