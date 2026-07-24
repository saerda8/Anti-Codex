import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..", "..");
const managerButton = readFileSync(resolve(root, "scripts", "test-anticodex-manager-button.mjs"), "utf8");
const managerButtons = readFileSync(resolve(root, "scripts", "test-anticodex-manager-real-buttons.ps1"), "utf8");
const shortcutRestore = readFileSync(resolve(root, "scripts", "test-anticodex-shortcut-restore.ps1"), "utf8");
const syncReadiness = readFileSync(resolve(root, "scripts", "test-anticodex-sync-readiness.ps1"), "utf8");

test("Manager direct probes atomically sign timestamped process and CDP-session reports while retaining stdout", () => {
  assert.match(managerButton, /function writeSignedJsonReport\(/);
  assert.match(managerButton, /function emitEvidenceReport\(/);
  assert.match(managerButton, /generatedAt/);
  assert.match(managerButton, /checkedAt/);
  assert.match(managerButton, /processIdentity/);
  assert.match(managerButton, /sessionIdentity/);
  assert.match(managerButton, /sha256:/);
  assert.match(managerButton, /renameSync\(/);
  assert.match(managerButton, /console\.log\(asciiJson/);
  assert.match(managerButton, /emitEvidenceReport\("manager-profile-entry"/);
  assert.match(managerButton, /emitEvidenceReport\("manager-upstream-protocol"/);
  assert.match(managerButton, /emitEvidenceReport\("manager-close-actual-mouse"/);
});

test("Manager report IO self-test produces verifiable latest and history sidecars without UI", () => {
  const reportRoot = mkdtempSync(resolve(tmpdir(), "anticodex-manager-report-"));
  try {
    const run = spawnSync(process.execPath, [
      resolve(root, "scripts", "test-anticodex-manager-button.mjs"),
      "--report-io-self-test", "1",
      "--report-root", reportRoot,
      "--compact", "1",
    ], { encoding: "utf8", windowsHide: true });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const payload = JSON.parse(run.stdout.trim());
    assert.equal(payload.ok, true);
    assert.match(payload.checkedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(payload.processIdentity.verifierPid > 0, true);
    assert.equal(payload.sessionIdentity.kind, "offline-report-io-self-test");
    for (const reportPath of [payload.report.latest, payload.report.history]) {
      const body = readFileSync(reportPath);
      const expected = `sha256:${createHash("sha256").update(body).digest("hex")}`;
      assert.equal(readFileSync(`${reportPath}.sha256`, "ascii"), expected);
    }
  } finally {
    rmSync(reportRoot, { recursive: true, force: true });
  }
});

test("Manager 20-button wrapper signs the same timestamp and runtime session identity it prints", () => {
  assert.match(managerButtons, /generatedAt = \$checkedAt/);
  assert.match(managerButtons, /checkedAt = \$checkedAt/);
  assert.match(managerButtons, /processIdentity = \$payload\.processIdentity/);
  assert.match(managerButtons, /sessionIdentity = \$payload\.sessionIdentity/);
  assert.match(managerButtons, /Write-AntiCodexJsonReport/);
  assert.match(managerButtons, /\$result \| ConvertTo-Json/);
});

test("shortcut restore writes signed timestamped PID and CDP-session evidence and still emits stdout", () => {
  assert.match(shortcutRestore, /\[ValidateSet\("DesktopShortcut",\s*"TaskbarButton"\)\]/);
  assert.match(shortcutRestore, /function Get-ExactAntiCodexTaskbarButton/);
  assert.match(shortcutRestore, /AccessibleObjectFromWindow/);
  assert.match(shortcutRestore, /\$windowCountSuffix = -join \(\[char\[\]\]@\(0x4E2A, 0x8FD0, 0x884C, 0x7A97, 0x53E3\)\)/);
  assert.match(shortcutRestore, /\$expectedAccessibleName = "\$ExpectedAutomationName - 1 \$windowCountSuffix"/);
  assert.match(shortcutRestore, /accHitTest/);
  assert.match(shortcutRestore, /if \(\$matches\.Count -ne 1\)[\s\S]*?throw/);
  assert.match(shortcutRestore, /GetCursorPos/);
  assert.match(shortcutRestore, /SetCursorPos/);
  assert.match(shortcutRestore, /SendInput/);
  assert.doesNotMatch(shortcutRestore, /mouse_event/);
  assert.doesNotMatch(shortcutRestore, /UIAutomationClient/);
  assert.match(shortcutRestore, /clickSentAtMs = \[int\]\$Stopwatch\.ElapsedMilliseconds[\s\S]*?SendLeftClick/);
  assert.doesNotMatch(shortcutRestore, /if \(\$activationObserved\) \{ Start-Sleep -Milliseconds 100 \}/);
  assert.match(shortcutRestore, /activationMode = \$activationModeReport/);
  assert.match(shortcutRestore, /actualMouse = \$actualMouse/);
  assert.match(shortcutRestore, /taskbarActivationObserved = \$taskbarActivationObserved/);
  assert.match(shortcutRestore, /taskbarElement = \$taskbarElementEvidence/);
  assert.match(shortcutRestore, /taskbarRectangle = \$taskbarRectangle/);
  assert.match(shortcutRestore, /taskbarClickPoint = \$taskbarClickPoint/);
  assert.match(shortcutRestore, /sameHwnd = \$sameHwnd/);
  assert.match(shortcutRestore, /samePid = \$samePid/);
  assert.match(shortcutRestore, /sameExecutable = \$sameExecutable/);
  assert.match(shortcutRestore, /sameCdpTarget = \$sameCdpTarget/);
  assert.match(shortcutRestore, /firstFrame = \$firstFrame/);
  assert.match(shortcutRestore, /firstFrameDelayMs = \$firstFrameDelayMs/);
  assert.match(shortcutRestore, /frameCaptureOrigin = "exact-foreground-window"/);
  assert.match(shortcutRestore, /frameCaptureOriginMs = \$frameCaptureOriginMs/);
  assert.match(shortcutRestore, /visibleWindowCriterion = "presentable-exact-executable-v1"/);
  assert.match(shortcutRestore, /maxSampleIntervalMs = \$maxSampleIntervalMs/);
  assert.match(shortcutRestore, /earlyFrameCount = \$earlyFrameCount/);
  assert.match(shortcutRestore, /maxVisibleTopLevelWindowCount = \$maxVisibleTopLevelWindowCount/);
  const taskbarBranch = shortcutRestore.match(
    /if \(\$ActivationMode -eq "TaskbarButton"\) \{[\s\S]*?\} else \{[\s\S]*?Start-Process/,
  )?.[0] ?? "";
  assert.match(taskbarBranch, /Invoke-TaskbarButtonActualMouseClick/);
  assert.doesNotMatch(
    taskbarBranch.slice(0, taskbarBranch.lastIndexOf("} else {")),
    /Start-Process/,
  );
  assert.match(shortcutRestore, /generatedAt = \$checkedAt/);
  assert.match(shortcutRestore, /checkedAt = \$checkedAt/);
  assert.match(shortcutRestore, /processIdentity = \[pscustomobject\]/);
  assert.match(shortcutRestore, /supervisorPid = \[int\]\$health\.pid/);
  assert.match(shortcutRestore, /codexPlusPlusPid = \[int\]\$codexPlusPlusPid/);
  assert.match(shortcutRestore, /antiCodexMainPid = \$ExpectedMainPid/);
  assert.match(shortcutRestore, /originalCodexPid = \$ExpectedOriginalCodexPid/);
  assert.match(shortcutRestore, /sessionIdentity = \[pscustomobject\]/);
  assert.match(shortcutRestore, /cdpPort = \$cdpPort/);
  assert.match(shortcutRestore, /targetId = \[string\]\$sessionAfter\.targetId/);
  assert.match(shortcutRestore, /\$sessionBefore\.targetId[\s\S]*?-ne \[string\]\$sessionAfter\.targetId/);
  assert.match(shortcutRestore, /Write-AntiCodexJsonReport/);
  assert.match(shortcutRestore, /latest-shortcut-restore\.json/);
  assert.match(shortcutRestore, /Write-Output \$json/);
});

test("sync readiness signs an absolute timestamp and explicit verifier session identity", () => {
  assert.match(syncReadiness, /generatedAt = \$checkedAt/);
  assert.match(syncReadiness, /checkedAt = \$checkedAt/);
  assert.match(syncReadiness, /processIdentity = \[pscustomobject\]/);
  assert.match(syncReadiness, /sessionIdentity = \[pscustomobject\]/);
  assert.match(syncReadiness, /Write-AntiCodexJsonReport/);
  assert.match(syncReadiness, /\$result \| ConvertTo-Json/);
});
