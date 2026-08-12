import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..", "..");
const plan = readFileSync(resolve(root, "task_plan.md"), "utf8");
const findings = readFileSync(resolve(root, "findings.md"), "utf8");
const acceptance = readFileSync(resolve(root, "docs", "CURRENT_LONG_TASK_ACCEPTANCE.md"), "utf8");

const installedSource = "20bcdefc307d1ecd7bb2966e6311be9aab1c6dad";
const priorSignedCandidate = "f7ec81f57875f6c6ebcbd423342dafac048098e4";
const compatibilityReplay = "7dc0ae34ada6168ccde6e2922b595e06b348b761";
const rev9PatchId = "82b24d6665d9707d64cc913ccc43fa733fc2b387";
const rejectedFinalCandidate = "5b590b443fd0f71f25dd052dbc74ee11ba06d4c8";
const finalCandidateParent = "21c4efb6c85de59809366144b1f23b0fcb35dabd";
const rev7ControlReport = "20260810-133920411-shortcut-restore-c2145848b6774098b2c18e60ae60208b.json";
const rev9FailureReport = "20260810-135242746-shortcut-restore-aa223b2c43714a99b54d095ee664a132.json";
const rev9FailureSha256 = "0530087aa23ad0aec45f5d206d3c44c44808db5c297e8fdb5b58a4084b258879";
const currentSourceHead = "c1fbf1bb253c213919441ea4618834792732cd79";
const currentSourcePreflightSha256 = "574160c6e9d71390f5cca0ece120d5d06e9dbdd37c8320ab4bea09c326b3e4f9";
const codexPlusPlusTagObject = "ad2e18adf66662fe0caec6fe87f1d544e3160c18";
const codexPlusPlusPeeledCommit = "a30b550135fb678bab600da59af153a403b285ee";
const codexPlusPlusMainHead = "1df20b9fb605e3d59290296a0b164c3ce943d0e1";
const officialRootCreatedAt = "2026-08-11T19:59:36.721724+08:00";
const officialCoreCreatedAt = "2026-08-11T19:59:46.568971+08:00";
const currentPreflightStartedAt = "2026-08-11T13:26:01.9940517Z";

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sectionAfterHeading(text, heading, nextHeadingPrefix) {
  const start = text.lastIndexOf(heading);
  assert.ok(start >= 0);
  const next = text.indexOf(`\n${nextHeadingPrefix}`, start + heading.length);
  return text.slice(start, next >= 0 ? next : text.length);
}

function appendToSection(text, heading, nextHeadingPrefix, line) {
  const start = text.lastIndexOf(heading);
  assert.ok(start >= 0);
  const next = text.indexOf(`\n${nextHeadingPrefix}`, start + heading.length);
  const end = next >= 0 ? next : text.length;
  return `${text.slice(0, end)}\n${line}${text.slice(end)}`;
}

function removeLineFromSection(text, heading, nextHeadingPrefix, pattern) {
  const section = sectionAfterHeading(text, heading, nextHeadingPrefix);
  const line = section.split(/\r?\n/).find((candidate) => pattern.test(candidate));
  assert.ok(line, `missing mutation target: ${pattern}`);
  return text.replace(line, "");
}

function assertNoUnqualifiedStaleOfficialTruth(planText, findingsText) {
  const staleLines = `${planText}\n${findingsText}`.split(/\r?\n/).filter((line) => (
    (/Microsoft Store currently offers no update beyond installed official Codex `26\.803\.5235\.0`/i.test(line)
      || /Official Codex remains installed at `26\.803\.5235\.0`.*Microsoft Store reports no newer available package/i.test(line))
    && !/(?:historical|superseded)/i.test(line)
  ));
  assert.deepEqual(staleLines, [], `unqualified stale official-version truth:\n${staleLines.join("\n")}`);

  const historicalPlanLine = planText.split(/\r?\n/).find((line) => /Microsoft Store.*26\.803\.5235\.0/i.test(line) && /no update beyond/i.test(line));
  const historicalFindingsLine = findingsText.split(/\r?\n/).find((line) => /Official Codex.*26\.803\.5235\.0/i.test(line) && /no newer available package/i.test(line));
  assert.match(historicalPlanLine ?? "", /historical.*superseded/i);
  assert.match(historicalFindingsLine ?? "", /historical.*superseded/i);
}

function assertCurrentUpdateTruth(planText, findingsText, acceptanceText) {
  const planCurrent = sectionAfterHeading(planText, "### 2026-08-11 current upstream drift and checkpoint boundary", "### ");
  const findingsCurrent = sectionAfterHeading(findingsText, "## 2026-08-11 current upstream drift findings", "## ");
  const acceptanceCurrent = sectionAfterHeading(acceptanceText, "## 2026-08-11 current upstream drift boundary", "## ");
  const current = `${planCurrent}\n${findingsCurrent}\n${acceptanceCurrent}`;

  assertNoUnqualifiedStaleOfficialTruth(planText, findingsText);

  for (const section of [planCurrent, findingsCurrent, acceptanceCurrent]) {
    assert.match(section, /26\.803\.10989\.0.*root PID `8800`.*core PID `40560`/is);
    assert.match(section, /revision 7.*26\.803\.5235\.0.*Anti-Codex process count is zero/is);
    assert.match(section, /not synchronized.*not physically accepted/is);
    assert.match(section, new RegExp(`${escapeRegExp(officialRootCreatedAt)}.*${escapeRegExp(officialCoreCreatedAt)}.*${escapeRegExp(currentPreflightStartedAt)}.*(?:precedes|before)`, "is"));
    assert.match(section, new RegExp(`${currentSourceHead}.*13/13.*1013/1013.*${currentSourcePreflightSha256}`, "is"));
    assert.match(section, /historical checkpoint.*before this documentation commit.*cannot authorize.*future activation/is);
    assert.match(section, new RegExp(`v1\\.2\\.46.*${codexPlusPlusTagObject}.*${codexPlusPlusPeeledCommit}.*v1\\.2\\.45`, "is"));
    assert.match(section, /v1\.2\.46.*(?:source replay|replay).*(?:not installable|ineligible for installation)/is);
    assert.match(section, new RegExp(`${codexPlusPlusMainHead}.*25 commits ahead.*code`, "is"));
    assert.match(section, /no observed helper-only path change.*does not accept.*future tag/is);
    assert.match(section, /authorizes no future shutdown, synchronization, restart, physical UI, or provider traffic/is);
  }
  assert.match(planCurrent, /source_codex_changed.*16\/16.*full candidate.*CLI.*not run.*new explicit authorization.*new exact-HEAD preflight/is);
  assert.match(findingsCurrent, /source_codex_changed.*temporary copy.*16\/16.*full candidate.*CLI.*not run/is);
  assert.match(acceptanceCurrent, /source_codex_changed.*new explicit authorization.*new exact-HEAD preflight/is);

  assert.match(current, /later upstream main commits only change website documentation.*(?:false|superseded|rejected)/is);

  const conflictLines = current.split(/\r?\n/).filter((line) => (
    (/Anti-Codex.*(?:is running|process count is [1-9]|synchronized|physically accepted)/i.test(line)
      && !/not synchronized.*not physically accepted/i.test(line))
    || /c1fbf1bb.*(?:current exact-HEAD|future activation checkpoint|authorizes future activation)/i.test(line)
    || (/later upstream main commits only change website documentation/i.test(line) && !/(?:false|superseded|rejected)/i.test(line))
    || /helper-only.*future tag.*(?:accepted|approved|installable)/i.test(line)
    || (/(?:future\s+)?(?:shutdown|synchronization|sync|restart|physical UI|provider(?: traffic)?).*(?:authorized|approved|permitted|allowed)/i.test(line)
      && !/(?:authorizes? no|no .*authorized|not .*authorized|requires? new explicit authorization)/i.test(line))
  ));
  assert.deepEqual(conflictLines, [], `current update truth conflicts:\n${conflictLines.join("\n")}`);
}

function assertCurrentInstalledTruth(planText, findingsText, acceptanceText = acceptance) {
  const current = sectionAfterHeading(planText, "### 2026-08-10 Rev9 physical rejection and Rev7 rollback", "### ");
  const checkpoint = sectionAfterHeading(planText, "### 2026-08-10 pre-A/B source checkpoint", "### ");
  const currentLines = current.split(/\r?\n/);
  const checkpointLines = checkpoint.split(/\r?\n/);
  const candidateLines = currentLines.filter((line) => line.includes(rejectedFinalCandidate));
  const controlLines = currentLines.filter((line) => line.includes(rev7ControlReport));
  const failureLines = currentLines.filter((line) => line.includes(rev9FailureReport));
  const rollbackLines = currentLines.filter((line) => /revision 7 is the current active shell/i.test(line));
  const futureAuthorizationLines = currentLines.filter((line) => /^\s*- \[ \] Do not repeat shutdown, synchronization, restart or physical UI testing/i.test(line));
  const priorCandidateLines = checkpointLines.filter((line) => line.includes(priorSignedCandidate) && /prior signed candidate checkpoint/i.test(line));
  const replayLines = checkpointLines.filter((line) => line.includes(compatibilityReplay) && /compatibility replay/i.test(line));

  assert.equal(candidateLines.length, 1);
  assert.match(candidateLines[0], new RegExp(`${finalCandidateParent}.*${rev9PatchId}.*13 checks.*1007/1007.*no traffic`, "i"));
  assert.equal(controlLines.length, 1);
  assert.match(controlLines[0], /one blank frame at `9 ms`.*first content at `81 ms`.*same PID\/HWND\/CDP/i);
  assert.equal(failureLines.length, 1);
  assert.match(failureLines[0], /first eight valid taskbar rounds had zero blank frames.*one blank frame at `7 ms`.*first content at `86 ms`.*PID, HWND, executable, CDP target and exact deadline foreground/i);
  assert.equal(rollbackLines.length, 1);
  assert.match(rollbackLines[0], /revision 9 is only the rejected rollback slot.*root PID `47220`.*core PID `19464`.*No model\/provider traffic/i);
  assert.equal(futureAuthorizationLines.length, 1);
  assert.match(futureAuthorizationLines[0], /Gate 5 remains red.*not 100%/i);
  assert.equal(priorCandidateLines.length, 1);
  assert.match(priorCandidateLines[0], /not deployed.*not physically accepted.*not the current activation candidate/i);
  assert.equal(replayLines.length, 1);
  assert.match(replayLines[0], /not an activation candidate/i);
  assert.doesNotMatch(current, new RegExp(installedSource, "i"));
  assert.equal(currentLines.filter((line) => /revision 9 is (?:the )?current active|Rev9.*physically accepted|eight clean rounds.*(?:pass|accepted)|Gate 5.*green|project is 100%/i.test(line)).length, 0);
  assert.equal(currentLines.filter((line) => /^\s*- \[x\].*(?:further|future|repeat).*(?:shutdown|synchroniz|restart|physical UI).*(?:authorized|allowed|granted)/i.test(line)).length, 0);
  assert.equal(checkpointLines.filter((line) => /f7ec81f5/i.test(line) && /(?:latest|current) candidate/i.test(line) && !/not the current activation candidate/i.test(line)).length, 0);
  assert.equal(checkpointLines.filter((line) => /7dc0ae34/i.test(line) && /\b(?:is|as)\s+(?:the\s+)?activation candidate/i.test(line) && !/not an activation candidate/i.test(line)).length, 0);

  const currentFindings = sectionAfterHeading(findingsText, "## 2026-08-10 Rev9 physical rejection and Rev7 rollback findings", "## ");
  const findingLines = currentFindings.split(/\r?\n/);
  const candidateFindingLines = findingLines.filter((line) => line.includes(rejectedFinalCandidate));
  const controlFindingLines = findingLines.filter((line) => line.includes(rev7ControlReport));
  const failureFindingLines = findingLines.filter((line) => line.includes(rev9FailureReport));
  const rollbackFindingLines = findingLines.filter((line) => /revision 7 is current and ready/i.test(line));

  assert.equal(candidateFindingLines.length, 1);
  assert.match(candidateFindingLines[0], new RegExp(`${finalCandidateParent}.*${rev9PatchId}.*13/13.*1007/1007`, "i"));
  assert.equal(controlFindingLines.length, 1);
  assert.match(controlFindingLines[0], /pure-white frame `9 ms`.*first content at `81 ms`/i);
  assert.equal(failureFindingLines.length, 1);
  assert.match(failureFindingLines[0], new RegExp(`${rev9FailureSha256}.*blank frame at \`7 ms\`.*first content at \`86 ms\`.*same PID/HWND/executable/CDP.*exact deadline foreground`, "i"));
  assert.equal(rollbackFindingLines.length, 1);
  assert.match(rollbackFindingLines[0], /rejected Rev9 is in the rollback slot.*root PID `47220`.*core PID `19464`.*No model\/provider traffic/i);
  assert.equal(findingLines.filter((line) => /Rev9.*physically accepted|revision 9 is current|eight clean rounds.*(?:pass|accepted)|grants future.*shutdown/i.test(line)).length, 0);

  const currentAcceptance = sectionAfterHeading(acceptanceText, "## 2026-08-09 Rev7 restore and tray override", "## ");
  assert.match(currentAcceptance, /revision 7 is current and ready.*revision 9 is only the rejected rollback slot.*root PID `47220`.*core PID `19464`.*No model\/provider traffic.*new explicit authorization.*not 100%/is);
  assert.doesNotMatch(planText, /the current installed Rev9 runtime was built from/i);
  assert.doesNotMatch(findingsText, /opacity-pulse candidate is still under evaluation.*has not been deployed/is);

  const currentTruth = `${current}\n${currentFindings}\n${currentAcceptance}`;
  assert.doesNotMatch(currentTruth, /provider traffic (?:was|is) used|used real traffic/i);
  assert.doesNotMatch(currentTruth, /(?:future|further|repeat).*(?:shutdown|synchroniz|restart|physical UI).*(?:is authorized|is allowed|is granted|may proceed)/i);
}

test("current revision truth cannot coexist with superseded unchecked activation instructions", () => {
  assert.match(plan, /\[x\].*Revision 7 is the current active shell.*revision 9 is only the rejected rollback slot/i);

  const unchecked = plan.split(/\r?\n/).filter((line) => /^\s*- \[ \]/.test(line));
  const supersededActivationPatterns = [
    /wait for the current Anti-Codex to exit naturally, then build and activate/i,
    /at the first all-zero Anti-Codex process window, build and activate exactly one fresh current candidate/i,
    /same 15-process owned product tree[\s\S]*run the source runtime sync once/i,
    /commit the current source[\s\S]*activate revision 6/i,
    /commit and activate the narrow trusted-root verifier correction/i,
  ];
  const conflicts = unchecked.filter((line) => supersededActivationPatterns.some((pattern) => pattern.test(line)));

  assert.deepEqual(conflicts, [], `superseded activation instructions remain unchecked:\n${conflicts.join("\n")}`);
});

test("current plan distinguishes rejected Rev9 from restored Rev7 and historical replays", () => {
  assertCurrentInstalledTruth(plan, findings);
});

test("current plan truth fails closed on promotion, authorization, or role drift", () => {
  const currentHeading = "### 2026-08-10 Rev9 physical rejection and Rev7 rollback";
  assert.throws(() => assertCurrentInstalledTruth(appendToSection(plan, currentHeading, "### ", "- [x] Further shutdown, synchronization, restart and physical UI testing is authorized."), findings));
  assert.throws(() => assertCurrentInstalledTruth(appendToSection(plan, currentHeading, "### ", "- [x] Revision 9 is the current active shell and is physically accepted."), findings));
  assert.throws(() => assertCurrentInstalledTruth(appendToSection(plan, currentHeading, "### ", "- [x] Eight clean rounds make Rev9 accepted despite the ninth valid failure."), findings));
  assert.throws(() => assertCurrentInstalledTruth(appendToSection(plan, "### 2026-08-10 pre-A/B source checkpoint", "### ", "- [x] Candidate f7ec81f5 is the latest candidate."), findings));
  assert.throws(() => assertCurrentInstalledTruth(appendToSection(plan, "### 2026-08-10 pre-A/B source checkpoint", "### ", "- [x] Compatibility replay 7dc0ae34 is the activation candidate."), findings));
  assert.throws(() => assertCurrentInstalledTruth(plan, appendToSection(findings, "## 2026-08-10 Rev9 physical rejection and Rev7 rollback findings", "## ", "- Revision 9 is current and physically accepted after eight clean rounds.")));
  assert.throws(() => assertCurrentInstalledTruth(plan, findings.replace("same PID/HWND/executable/CDP and exact deadline foreground", "changed PID/HWND/CDP and lost foreground")));
  assert.throws(() => assertCurrentInstalledTruth(plan, findings.replace("root PID `47220` and core PID `19464`", "root PID `1` and core PID `2`")));
  assert.throws(() => assertCurrentInstalledTruth(plan, findings, appendToSection(acceptance, "## 2026-08-09 Rev7 restore and tray override", "## ", "- Provider traffic was used during the Rev9 experiment.")));
  assert.throws(() => assertCurrentInstalledTruth(plan, appendToSection(findings, "## 2026-08-10 Rev9 physical rejection and Rev7 rollback findings", "## ", "- Further shutdown, synchronization, restart and physical UI testing is authorized.")));
});

test("current truth records the rejected Rev9 physical A/B and restored Rev7", () => {
  const current = sectionAfterHeading(plan, "### 2026-08-10 Rev9 physical rejection and Rev7 rollback", "### ");
  assert.match(current, new RegExp(`${rejectedFinalCandidate}.*Physically reject Rev9`, "is"));
  assert.match(current, /revision 7 is the current active shell.*revision 9 is only the rejected rollback slot/i);
  assert.match(current, new RegExp(`${rev7ControlReport}.*blank.*9 ms.*81 ms`, "i"));
  assert.match(current, new RegExp(`${rev9FailureReport}.*blank.*7 ms.*86 ms`, "i"));
  assert.match(current, /no model\/provider traffic/i);
});

test("current documents bind official Codex drift, historical preflight, and CodexPlusPlus upstream truth", () => {
  assertCurrentUpdateTruth(plan, findings, acceptance);
});

test("current update truth fails closed on append-only synchronization, checkpoint, or upstream conflicts", () => {
  const planHeading = "### 2026-08-11 current upstream drift and checkpoint boundary";
  const findingsHeading = "## 2026-08-11 current upstream drift findings";
  const acceptanceHeading = "## 2026-08-11 current upstream drift boundary";
  assert.throws(() => assertCurrentUpdateTruth(appendToSection(plan, planHeading, "### ", "- [x] Anti-Codex is synchronized and physically accepted."), findings, acceptance));
  assert.throws(() => assertCurrentUpdateTruth(plan, appendToSection(findings, findingsHeading, "## ", `- ${currentSourceHead} is the current exact-HEAD future activation checkpoint.`), acceptance));
  assert.throws(() => assertCurrentUpdateTruth(plan, findings, appendToSection(acceptance, acceptanceHeading, "## ", "- Later upstream main commits only change website documentation.")));
  assert.throws(() => assertCurrentUpdateTruth(plan, findings, appendToSection(acceptance, acceptanceHeading, "## ", "- The helper-only future tag is accepted and installable.")));
  assert.throws(() => assertCurrentUpdateTruth(appendToSection(plan, planHeading, "### ", "- Future shutdown is authorized."), findings, acceptance));
  assert.throws(() => assertCurrentUpdateTruth(plan, appendToSection(findings, findingsHeading, "## ", "- Future synchronization and restart are approved."), acceptance));
  assert.throws(() => assertCurrentUpdateTruth(plan, findings, appendToSection(acceptance, acceptanceHeading, "## ", "- Future physical UI is allowed.")));
  assert.throws(() => assertCurrentUpdateTruth(plan, findings, appendToSection(acceptance, acceptanceHeading, "## ", "- Future provider traffic is authorized.")));
  assert.throws(() => assertCurrentUpdateTruth(plan + "\n- The Microsoft Store currently offers no update beyond installed official Codex `26.803.5235.0`.", findings, acceptance));
  assert.throws(() => assertCurrentUpdateTruth(plan, findings + "\n- Official Codex remains installed at `26.803.5235.0`; the Microsoft Store reports no newer available package.", acceptance));
  assert.throws(() => assertCurrentUpdateTruth(removeLineFromSection(plan, planHeading, "### ", new RegExp(currentSourceHead)), findings, acceptance));
  assert.throws(() => assertCurrentUpdateTruth(plan, removeLineFromSection(findings, findingsHeading, "## ", new RegExp(codexPlusPlusTagObject)), acceptance));
  assert.throws(() => assertCurrentUpdateTruth(plan, findings, removeLineFromSection(acceptance, acceptanceHeading, "## ", new RegExp(codexPlusPlusMainHead))));
});
