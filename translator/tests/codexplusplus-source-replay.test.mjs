import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const componentRoot = join(root, "third_party", "codexplusplus");
const acceptedPath = join(componentRoot, "upstream.json");
const proposalRoot = join(root, "docs", "audits", "codexplusplus", "v1.2.46-source-replay");
const proposalPath = join(proposalRoot, "source-replay.json");

function normalizedTextSha256(path) {
  const normalized = readFileSync(path, "utf8").replaceAll("\r\n", "\n");
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

test("accepted v1.2.46 component is derived from the reviewed source replay", () => {
  const accepted = JSON.parse(readFileSync(acceptedPath, "utf8"));
  const proposal = JSON.parse(readFileSync(proposalPath, "utf8"));

  assert.equal(accepted.version, "1.2.46");
  assert.equal(accepted.tag, "v1.2.46");
  assert.equal(accepted.upstreamCommit, "a30b550135fb678bab600da59af153a403b285ee");
  assert.equal(accepted.patches.length, 13);
  assert.ok(accepted.patches.every(({ file }) => file.startsWith("patches/")));
  assert.equal(accepted.patches.at(-1).file, "patches/0013-fix-format-dreamskin-installer-test.patch");

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
  assert.equal(proposal.repository, accepted.repository);
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
  assert.equal(accepted.isolationPatchCommit, proposal.replay.isolationPatchCommit);
  assert.equal(accepted.patchCommit, proposal.replay.patchCommit);
  assert.match(accepted.verification.patchReplay, new RegExp(proposal.replay.patchTree));
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

test("component documentation records the accepted v1.2.46 promotion", () => {
  const readme = readFileSync(join(componentRoot, "README.md"), "utf8");

  assert.match(readme, /Accepted version: `v1\.2\.46`/);
  assert.match(readme, /checkout a30b550135fb678bab600da59af153a403b285ee/);
  assert.match(readme, /thirteen patches replay without conflict on pinned upstream `v1\.2\.46`/);
  assert.match(readme, /historical source-replay record/);
  assert.match(readme, /managed build, Windows launchability and candidate publication passed/);
  assert.doesNotMatch(readme, /Version: `v1\.2\.44`/);
  assert.doesNotMatch(readme, /checkout 77091ccaee4423f35a1b2c51c4ecd703e6201092/);
});
