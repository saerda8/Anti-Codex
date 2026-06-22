# Real Task Manager Evidence Audit (2026-06-22)

This report evaluates if the Anti-Codex management page and reports
allow users to judge whether the real task chain is usable.

## Covered Items (Evidence Present)

1. Guard Wording Verification:
   The overall installation test validates that the guard wording block in
   'adaptive-server.mjs' contains proper instructions (e.g. 'Anti-Codex',
   no 'DeepCodex' leaks, user-readable fake-execution checks) preventing
   models from cheating/faking tool executions instead of using the real path.

2. Strict Report Encoding Check:
   'Test-ReportEncoding' verifies that fresh report JSON files are properly
   parsed and do not contain a UTF-8 BOM, ensuring the manager server reads
   them without parsing failures.

3. Structured Reports for Real Tasks:
   'latestManagerReportsPayload' explicitly lists 'latest-real-work.json'
   and 'latest-real-mini-tool.json' to expose the status, execution times,
   and first failure messages of the real task chains.

## Evidence Gaps (Missing Items)

1. Stale Verification Evidence:
   Although the age of the report is reported, the management page does not
   have a warning threshold for stale files. A report indicating 'OK' from
   an older session might hide a current breakage.

2. Inability to Trigger Real Tasks from UI:
   Real task reports are written by CLI scripts (e.g., 'test-anticodex-real-work.ps1')
   but cannot be triggered directly from the management page actions.
   The UI is purely a passive reader for these specific reports.

3. Labeled Failures Lack Detail:
   The UI reports only the first failure string up to 240 chars. Users
   wishing to diagnose root causes must manually inspect the JSON file on disk,
   making it hard to judge why the task chain failed.
