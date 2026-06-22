# Anti-Codex Manager UI Follow-up Audit

Date: 2026-06-22
Status: Completed

## Findings & UX Risks

1. Broken session lock reset status display:
   In actionText(), r.activeReleased and r.queuedCancelled are accessed on the
   top-level payload.result. However, the server wraps these in result.result,
   making them always show up as undefined (No/0) in the manager UI.

2. Concurrency risk for long-running scripts:
   Only the clicked button is disabled during execution. For heavy synchronous
   actions (e.g., overallNoTraffic with 240s timeout), users can click other
   buttons or run them in parallel, causing resource contention and conflicts.

3. Dead-end "upstreamConfig" action:
   The "Configure Third-party API" button is virtual and only displays static
   text instructing the user to open it elsewhere, without providing an actual
   inline config option or modal.

4. Misleading paths for non-existent reports:
   For reports that do not exist, latestReportsSummary() still displays the
   full resolved local file path in the UI, confusing users into thinking the
   report file is available.

5. Unclickable plain-text report paths:
   Report paths shown by "viewLatestReports" are rendered as plain text. The
   manager UI lacks hyperlinks or inline tools to view/download reports.

## Recommendations

- Fix property path mapping for resetAntigravitySessionLock in actionText().
- Disable all action buttons globally while any sync action is executing.
- Hide file paths for reports that do not exist yet.
