import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..", "..");
const plan = readFileSync(resolve(root, "task_plan.md"), "utf8");
const findings = readFileSync(resolve(root, "findings.md"), "utf8");

const installedSource = "20bcdefc307d1ecd7bb2966e6311be9aab1c6dad";
const priorSignedCandidate = "f7ec81f57875f6c6ebcbd423342dafac048098e4";
const compatibilityReplay = "7dc0ae34ada6168ccde6e2922b595e06b348b761";
const rev9PatchId = "82b24d6665d9707d64cc913ccc43fa733fc2b387";

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

function assertCurrentInstalledTruth(planText, findingsText) {
  const authorization = sectionAfterHeading(planText, "### 2026-08-10 current authorization boundary", "### ");
  const checkpoint = sectionAfterHeading(planText, "### 2026-08-10 current source checkpoint", "### ");
  const authorizationLines = authorization.split(/\r?\n/);
  const checkpointLines = checkpoint.split(/\r?\n/);
  const installedLines = authorizationLines.filter((line) => line.includes(installedSource) && /current installed experimental shell/i.test(line));
  const priorCandidateLines = checkpointLines.filter((line) => line.includes(priorSignedCandidate) && /prior signed candidate checkpoint/i.test(line));
  const replayLines = checkpointLines.filter((line) => line.includes(compatibilityReplay) && /compatibility replay/i.test(line));
  const authorizationGateLines = authorizationLines.filter((line) => /^\s*- \[ \] Before any replacement of installed /i.test(line));

  assert.equal(installedLines.length, 1);
  assert.match(installedLines[0], /\[x\].*revision 9 is the current installed experimental shell.*Rev9 is not physically accepted/i);
  assert.match(installedLines[0], /validated revision 7 is the rollback release/i);
  assert.equal(priorCandidateLines.length, 1);
  assert.match(priorCandidateLines[0], /not deployed.*not physically accepted.*not the current activation candidate/i);
  assert.equal(replayLines.length, 1);
  assert.match(replayLines[0], /not an activation candidate/i);
  assert.equal(authorizationGateLines.length, 1);
  assert.match(authorizationGateLines[0], new RegExp(`20bcdefc.*parent.*then-current clean main.*${rev9PatchId}.*fresh signed no-traffic preflight.*controlled-shutdown.*synchronization.*restart.*physical-UI authorization`, "i"));

  const current = `${authorization}\n${checkpoint}`;
  const currentLines = current.split(/\r?\n/);
  const rev9Identity = /\bRev(?:ision)?\s*9\b/i;
  const priorCandidateIdentity = new RegExp(`(?:${priorSignedCandidate}|f7ec81f5)`, "i");
  const replayIdentity = new RegExp(`(?:${compatibilityReplay}|7dc0ae34)`, "i");
  const candidateIdentity = new RegExp(`(?:${priorSignedCandidate}|f7ec81f5|${compatibilityReplay}|7dc0ae34|activation candidate)`, "i");
  const checkedHighImpactAuthorization = /^\s*- \[x\](?=.*(?:controlled-)?shutdown)(?=.*synchroniz)(?=.*restart)(?=.*physical[- ]UI)/i;
  assert.doesNotMatch(current, /revision 7 is current|running installation remains revision 7/i);
  assert.equal(currentLines.filter((line) => priorCandidateIdentity.test(line) && /(?:latest|current) candidate/i.test(line) && !/not the current activation candidate/i.test(line)).length, 0);
  assert.equal(currentLines.filter((line) => replayIdentity.test(line) && /\b(?:is|as)\s+(?:the\s+)?activation candidate/i.test(line) && !/not an activation candidate/i.test(line)).length, 0);
  assert.equal(currentLines.filter((line) => checkedHighImpactAuthorization.test(line)).length, 0);
  assert.equal(currentLines.filter((line) => rev9Identity.test(line) && /physically accepted/i.test(line) && !/not physically accepted/i.test(line)).length, 0);
  assert.equal(currentLines.filter((line) => candidateIdentity.test(line) && /(?:has been|is|was) deployed|deployed and accepted/i.test(line) && !/not deployed/i.test(line)).length, 0);

  const currentFindings = sectionAfterHeading(findingsText, "## 2026-08-10 installed Rev9 plan-truth findings", "## ");
  const findingLines = currentFindings.split(/\r?\n/);
  const installedFindingLines = findingLines.filter((line) => line.includes(installedSource));
  const candidateFindingLines = findingLines.filter((line) => line.includes(priorSignedCandidate));
  const replayFindingLines = findingLines.filter((line) => line.includes(compatibilityReplay));
  const identityFindingLines = findingLines.filter((line) => line.includes(rev9PatchId) && /signed preflight/i.test(line));
  const authorizationFindingLines = findingLines.filter((line) => /grants no shutdown, synchronization, restart, UI or provider authorization/i.test(line));

  assert.equal(installedFindingLines.length, 1);
  assert.match(installedFindingLines[0], /active host marker is Rev9.*Rev7 rollback pair/i);
  assert.equal(candidateFindingLines.length, 1);
  assert.match(candidateFindingLines[0], /prior signed candidate.*not current/i);
  assert.equal(replayFindingLines.length, 1);
  assert.match(replayFindingLines[0], /compatibility replay.*not an activation candidate/i);
  assert.equal(identityFindingLines.length, 1);
  assert.match(identityFindingLines[0], /parent.*current clean main.*exact HEAD.*signed preflight/i);
  assert.equal(authorizationFindingLines.length, 1);
  assert.equal(findingLines.filter((line) => rev9Identity.test(line) && /physically accepted/i.test(line) && !/not physically accepted/i.test(line)).length, 0);
  assert.equal(findingLines.filter((line) => replayIdentity.test(line) && /\b(?:is|as)\s+(?:the\s+)?activation candidate/i.test(line) && !/not an activation candidate/i.test(line)).length, 0);
  assert.equal(findingLines.filter((line) => candidateIdentity.test(line) && /(?:has been|is|was) deployed/i.test(line) && !/not deployed/i.test(line)).length, 0);
  assert.equal(findingLines.filter((line) => /(?=.*(?:grants|authoriz))(?=.*shutdown)(?=.*synchroniz)(?=.*restart)(?=.*\bUI\b)/i.test(line) && !/grants no shutdown/i.test(line)).length, 0);
}

test("current revision truth cannot coexist with superseded unchecked activation instructions", () => {
  assert.match(plan, /\[x\].*revision 9 is the current installed experimental shell/i);

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

test("current plan distinguishes installed Rev9 from historical replays and self-hash-free candidate identity", () => {
  assertCurrentInstalledTruth(plan, findings);
});

test("current plan truth fails closed on promotion, authorization, or role drift", () => {
  assert.throws(() => assertCurrentInstalledTruth(appendToSection(plan, "### 2026-08-10 current authorization boundary", "### ", "- [x] Controlled-shutdown, synchronization, restart and physical-UI authorization is granted."), findings));
  assert.throws(() => assertCurrentInstalledTruth(appendToSection(plan, "### 2026-08-10 current authorization boundary", "### ", "- [x] Revision 9 is physically accepted."), findings));
  assert.throws(() => assertCurrentInstalledTruth(appendToSection(plan, "### 2026-08-10 current source checkpoint", "### ", "- [x] Candidate f7ec81f5 is the latest candidate."), findings));
  assert.throws(() => assertCurrentInstalledTruth(appendToSection(plan, "### 2026-08-10 current source checkpoint", "### ", "- [x] Compatibility replay 7dc0ae34 is the activation candidate."), findings));
  assert.throws(() => assertCurrentInstalledTruth(plan, appendToSection(findings, "## 2026-08-10 installed Rev9 plan-truth findings", "## ", "- The current plan grants shutdown, synchronization, restart, UI and provider authorization.")));
  assert.throws(() => assertCurrentInstalledTruth(plan, findings.replace("Rev7 rollback pair", "rollback pair")));
});
