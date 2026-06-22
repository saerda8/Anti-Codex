# Recovery Verifier Timeout Fix

## Symptom
The recovery verifier encountered intermittent timeouts or process tracking failures because `WaitForExit(ms)` was unreliable in Windows PowerShell 5.1 here.

## Root Cause
Calling `WaitForExit(ms)` did not consistently wait for the subprocess to complete in the Windows PowerShell 5.1 environment.

## Fix
Introducing stdout/stderr redirection plus `HasExited` polling fixed it by ensuring reliable detection of the process status.

## Verification
The installed recovery verifier passed in about 9.4 seconds, confirming `accountReady=true` and `modelCount=8`.

## Guardrails
The verification has run successfully while ensuring that `originalCodexConfigUnchanged=true` remains true.
