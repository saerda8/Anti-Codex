# Child Process Timeout Hardening

## Problem
Windows PowerShell 5.1 WaitForExit(timeout) was unreliable on this host.

## Changed Entrypoints
The following scripts now use HasExited polling for bounded waits:
- start-deepcodex.ps1
- manage-anticodex.ps1
- sync-anticodex.ps1
- test-anticodex-installed-overall.ps1

## Encoding Note
manage-anticodex.ps1 is UTF-8 with BOM because it is executed directly by Windows PowerShell 5.1 and contains Chinese UI strings.

## Verification
- Launcher regression passed 75/75
- Installed fast no-traffic overall passed
- Manager status command returned Chinese status with 8 models
