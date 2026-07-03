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
    $currentUserSid = ""
    try {
        $currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
        if ($currentIdentity -and $currentIdentity.User) {
            $currentUserSid = [string]$currentIdentity.User.Value
        }
    } catch {
        $currentUserSid = ""
    }
    $localUserName = ""
    $lookupAvailable = [bool](Get-Command "Get-LocalUser" -ErrorAction SilentlyContinue)
    $lookupError = ""
    $targetExists = $null
    $targetUserSid = ""
    $targetUserEnabled = $null
    if ($normalizedTarget -match ('^{0}\\(.+)$' -f [regex]::Escape($env:COMPUTERNAME))) {
        $localUserName = $Matches[1]
    }
    if ($lookupAvailable -and $localUserName) {
        try {
            $targetUser = Get-LocalUser -Name $localUserName -ErrorAction Stop
            $targetExists = $true
            if ($targetUser -and ($targetUser.PSObject.Properties.Name -contains "Enabled")) {
                $targetUserEnabled = [bool]$targetUser.Enabled
            }
            if ($targetUser -and $targetUser.SID) {
                $targetUserSid = [string]$targetUser.SID.Value
            }
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
    $targetUserSidMatchesCurrentUser = ($targetUserSid -and $currentUserSid -and $targetUserSid.Equals($currentUserSid, [StringComparison]::OrdinalIgnoreCase))
    if ($targetUserSidMatchesCurrentUser) {
        $targetIsCurrent = $true
    }
    $targetUserIdentityBoundaryOk = ($targetExists -eq $true -and [string]$targetUserSid -and [string]$currentUserSid -and -not $targetUserSidMatchesCurrentUser)
    $targetUserLoginEnabled = ($targetUserEnabled -ne $false)
    $ready = ($targetExists -eq $true -and -not $targetIsCurrent -and $targetUserIdentityBoundaryOk -and $targetUserLoginEnabled)
    $blockingReason = ""
    if ($targetIsCurrent) {
        $blockingReason = "target_windows_user_is_current_user"
    } elseif ($targetExists -eq $false) {
        $blockingReason = "target_windows_user_missing"
    } elseif ($targetUserEnabled -eq $false) {
        $blockingReason = "target_windows_user_disabled"
    } elseif ($targetExists -eq $true -and -not $targetUserIdentityBoundaryOk) {
        $blockingReason = "target_windows_user_identity_unverified"
    } elseif ($targetExists -ne $true) {
        $blockingReason = "target_windows_user_lookup_unknown"
    }
    return [ordered]@{
        readinessChecked = $true
        targetWindowsUser = $Name
        normalizedTargetWindowsUser = $normalizedTarget
        currentWindowsUser = $currentUser
        currentWindowsUserSid = $currentUserSid
        targetWindowsUserSid = $targetUserSid
        targetUserSidMatchesCurrentUser = [bool]$targetUserSidMatchesCurrentUser
        targetUserIdentityBoundaryOk = [bool]$targetUserIdentityBoundaryOk
        localUserLookupAvailable = $lookupAvailable
        targetUserExists = $targetExists
        targetUserEnabled = $targetUserEnabled
        targetUserIsCurrentUser = $targetIsCurrent
        readyForInteractiveLogin = $ready
        readinessBlockingReason = $blockingReason
        readinessLookupError = $lookupError
    }
}

function Get-LoginOperatorNextStep {
    param([string]$BlockingReason)
    switch ($BlockingReason) {
        "target_windows_user_missing" { return "open_elevated_windows_user_settings_then_rerun_prepare" }
        "target_windows_user_is_current_user" { return "choose_separate_windows_user_then_rerun_prepare" }
        "target_windows_user_identity_unverified" { return "verify_windows_user_identity_then_rerun_prepare" }
        "target_windows_user_lookup_unknown" { return "verify_windows_user_manually_then_rerun_prepare" }
        default { return "verify_windows_user_manually_then_rerun_prepare" }
    }
}

$commandParts = @(
    "powershell.exe",
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
$runasWorkingDirectory = Join-Path $env:SystemRoot "System32"
if (-not (Test-Path -LiteralPath $runasWorkingDirectory -PathType Container)) {
    $runasWorkingDirectory = $env:USERPROFILE
}
$readiness = Get-LocalWindowsUserReadiness -Name $WindowsUser
$safeToAskUserForSecondAccountLogin = ($readiness.readyForInteractiveLogin -eq $true)
$blockedBeforeInteractiveLogin = -not $safeToAskUserForSecondAccountLogin
$operatorBlockingStage = if ($safeToAskUserForSecondAccountLogin) {
    "ready"
} elseif ($readiness.readinessBlockingReason -eq "target_windows_user_missing") {
    "target_user_missing_blocked_before_login"
} elseif ($readiness.readinessBlockingReason -eq "target_windows_user_is_current_user") {
    "target_user_is_current_user"
} elseif ($readiness.readinessBlockingReason -eq "target_windows_user_lookup_unknown") {
    "target_user_lookup_unknown_blocked_before_login"
} else {
    "unknown_blocked_before_login"
}
$operatorNextStep = if ($safeToAskUserForSecondAccountLogin) {
    "run_windows_user_interactive_login_with_user_present"
} else {
    Get-LoginOperatorNextStep -BlockingReason $readiness.readinessBlockingReason
}

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
    currentWindowsUserSid = $readiness.currentWindowsUserSid
    targetWindowsUserSid = $readiness.targetWindowsUserSid
    targetUserSidMatchesCurrentUser = $readiness.targetUserSidMatchesCurrentUser
    targetUserIdentityBoundaryOk = $readiness.targetUserIdentityBoundaryOk
    localUserLookupAvailable = $readiness.localUserLookupAvailable
    targetUserExists = $readiness.targetUserExists
    targetUserIsCurrentUser = $readiness.targetUserIsCurrentUser
    readyForInteractiveLogin = $readiness.readyForInteractiveLogin
    readinessBlockingReason = $readiness.readinessBlockingReason
    readinessLookupError = $readiness.readinessLookupError
    safeToAskUserForSecondAccountLogin = $safeToAskUserForSecondAccountLogin
    canProceedToInteractiveLogin = $safeToAskUserForSecondAccountLogin
    blockedBeforeInteractiveLogin = $blockedBeforeInteractiveLogin
    operatorBlockingStage = $operatorBlockingStage
    operatorNextStep = $operatorNextStep
    credentialBoundary = "separate-windows-user"
    expectedCredentialStoreIsolation = $true
    accountIsolationCaveat = "This opens an interactive runas prompt. The password is handled by Windows runas, not by Codex. Login proof still requires explicit user-approved real traffic and account identity comparison."
    command = $Command
    runasFile = "runas.exe"
    runasArgs = @("/user:$WindowsUser", $runasCommand)
    runasWorkingDirectory = $runasWorkingDirectory
    bootstrapKeepsShellOpen = $false
}

if ($DryRun) {
    $result.started = $false
    $result | ConvertTo-Json -Depth 12 -Compress
    exit 0
}

if (-not $safeToAskUserForSecondAccountLogin) {
    $result.ok = $false
    $result.started = $false
    $result.error = "windows_user_not_ready_for_interactive_login"
    $result | ConvertTo-Json -Depth 12 -Compress
    exit 2
}

Start-Process -FilePath "runas.exe" -ArgumentList $result.runasArgs -WorkingDirectory $runasWorkingDirectory -WindowStyle Normal | Out-Null
$result.started = $true
$result | ConvertTo-Json -Depth 12 -Compress
