#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$WindowsUser,
    [string]$Command = "login",
    [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$runnerPath = Join-Path $PSScriptRoot "start-anticodex-antigravity-cli-login.ps1"
if (-not (Test-Path -LiteralPath $runnerPath -PathType Leaf)) {
    throw "missing same-user file-isolation runner: $runnerPath"
}

function Get-NormalizedWindowsUserName {
    param([string]$Name)
    $value = ([string]$Name).Trim()
    if (-not $value) { return "" }
    if ($value -match '^\.\\(.+)$') { return "$env:COMPUTERNAME\$($Matches[1])" }
    if ($value -notmatch '\\' -and $value -notmatch '@') { return "$env:COMPUTERNAME\$value" }
    return $value
}

function Get-LocalWindowsUserReadiness {
    param([string]$Name)
    $normalizedTarget = Get-NormalizedWindowsUserName -Name $Name
    $currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $localUserName = ""
    $lookupAvailable = [bool](Get-Command "Get-LocalUser" -ErrorAction SilentlyContinue)
    $lookupError = ""
    $targetExists = $null
    if ($normalizedTarget -match ('^{0}\\(.+)$' -f [regex]::Escape($env:COMPUTERNAME))) {
        $localUserName = $Matches[1]
    }
    if ($lookupAvailable -and $localUserName) {
        try {
            Get-LocalUser -Name $localUserName -ErrorAction Stop | Out-Null
            $targetExists = $true
        } catch {
            $targetExists = $false
            $lookupError = $_.Exception.Message
        }
    } elseif (-not $lookupAvailable) {
        $lookupError = "Get-LocalUser is unavailable in this PowerShell environment."
    } else {
        $lookupError = "Target user is not a local Windows user name."
    }
    $targetIsCurrent = ($normalizedTarget -and $currentUser -and $normalizedTarget.Equals($currentUser, [StringComparison]::OrdinalIgnoreCase))
    $ready = ($targetExists -eq $true -and -not $targetIsCurrent)
    $blockingReason = ""
    if ($targetIsCurrent) {
        $blockingReason = "target_windows_user_is_current_user"
    } elseif ($targetExists -eq $false) {
        $blockingReason = "target_windows_user_missing"
    } elseif ($targetExists -ne $true) {
        $blockingReason = "target_windows_user_lookup_unknown"
    }
    return [ordered]@{
        readinessChecked = $true
        targetWindowsUser = $Name
        normalizedTargetWindowsUser = $normalizedTarget
        currentWindowsUser = $currentUser
        localUserLookupAvailable = $lookupAvailable
        targetUserExists = $targetExists
        targetUserIsCurrentUser = $targetIsCurrent
        readyForInteractiveLogin = $ready
        readinessBlockingReason = $blockingReason
        readinessLookupError = $lookupError
    }
}

$commandParts = @(
    "powershell.exe",
    "-NoExit",
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    ('"{0}"' -f $runnerPath),
    "-AllowFileIsolationOnly"
)
if ($Command) {
    $commandParts += "-Command"
    $commandParts += ('"{0}"' -f ($Command.Replace('"', '\"')))
}
$runasCommand = $commandParts -join " "
$readiness = Get-LocalWindowsUserReadiness -Name $WindowsUser

$result = [ordered]@{
    ok = $true
    reportName = "antigravity-cli-windows-user-login-terminal"
    noTraffic = $true
    usedRealTraffic = $false
    capturesLoginOutput = $false
    windowsUser = $WindowsUser
    readinessChecked = $readiness.readinessChecked
    normalizedTargetWindowsUser = $readiness.normalizedTargetWindowsUser
    currentWindowsUser = $readiness.currentWindowsUser
    localUserLookupAvailable = $readiness.localUserLookupAvailable
    targetUserExists = $readiness.targetUserExists
    targetUserIsCurrentUser = $readiness.targetUserIsCurrentUser
    readyForInteractiveLogin = $readiness.readyForInteractiveLogin
    readinessBlockingReason = $readiness.readinessBlockingReason
    readinessLookupError = $readiness.readinessLookupError
    credentialBoundary = "separate-windows-user"
    expectedCredentialStoreIsolation = $true
    accountIsolationCaveat = "This opens an interactive runas prompt. The password is handled by Windows runas, not by Codex. Login proof still requires explicit user-approved real traffic and account identity comparison."
    command = $Command
    runasFile = "runas.exe"
    runasArgs = @("/user:$WindowsUser", $runasCommand)
}

if ($DryRun) {
    $result.started = $false
    $result | ConvertTo-Json -Depth 12 -Compress
    exit 0
}

Start-Process -FilePath "runas.exe" -ArgumentList $result.runasArgs -WindowStyle Normal | Out-Null
$result.started = $true
$result | ConvertTo-Json -Depth 12 -Compress
