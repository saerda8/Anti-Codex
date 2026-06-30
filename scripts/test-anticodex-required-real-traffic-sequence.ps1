[CmdletBinding()]
param(
    [string]$ReportRoot = $(Join-Path $env:APPDATA "anticodex\reports")
)

$ErrorActionPreference = "Stop"
$startedAt = [DateTime]::UtcNow

function Read-JsonFile {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    $text = [IO.File]::ReadAllText($Path, [Text.UTF8Encoding]::new($false))
    if ($text.Length -gt 0 -and $text[0] -eq [char]0xFEFF) { $text = $text.Substring(1) }
    return $text | ConvertFrom-Json
}

function As-Array {
    param($Value)

    if ($null -eq $Value) { return @() }
    if ($Value -is [array]) { return @($Value) }
    return @($Value)
}

function Write-Report {
    param([Parameter(Mandatory = $true)]$Payload)

    New-Item -ItemType Directory -Force -Path $ReportRoot | Out-Null
    $latest = Join-Path $ReportRoot "latest-required-real-traffic-sequence.json"
    $stamp = (Get-Date).ToUniversalTime().ToString("yyyyMMdd-HHmmss")
    $history = Join-Path $ReportRoot "$stamp-required-real-traffic-sequence.json"
    $Payload | Add-Member -NotePropertyName report -NotePropertyValue ([ordered]@{
        latest = $latest
        history = $history
    }) -Force
    $json = ($Payload | ConvertTo-Json -Depth 20) + "`n"
    foreach ($path in @($latest, $history)) {
        $tmp = "$path.$PID.tmp"
        [IO.File]::WriteAllText($tmp, $json, [Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $tmp -Destination $path -Force
        $sha = [Security.Cryptography.SHA256]::Create()
        try {
            $hash = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($json))).Replace("-", "").ToLowerInvariant()
        } finally {
            $sha.Dispose()
        }
        [IO.File]::WriteAllText("$path.sha256", "$hash`n", [Text.ASCIIEncoding]::new())
    }
}

$approvalPath = Join-Path $ReportRoot "latest-real-approval-plan.json"
$approval = Read-JsonFile $approvalPath
$expectedRequiredGateIds = @("accountProxyReadiness", "postVerification")
$releaseGates = $approval.releaseRealTrafficGates
$requiredReleaseComplete = ($releaseGates.requiredReleaseComplete -eq $true)
$requiredActions = @(As-Array $approval.releaseRealTrafficGates.requiredActions)
if ($requiredActions.Count -eq 0) {
    $requiredActions = @(As-Array $approval.releaseRealTrafficGates.actions)
}
$optionalActions = @(As-Array $approval.releaseRealTrafficGates.optionalActions)
$requiredGateIds = @(As-Array $releaseGates.requiredGateIds | ForEach-Object { [string]$_ } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
if ($requiredGateIds.Count -eq 0) {
    $requiredGateIds = @(As-Array $releaseGates.gateIds | ForEach-Object { [string]$_ } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
}
$completedRequiredGateIds = @(As-Array $releaseGates.completedGateIds | ForEach-Object { [string]$_ } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
$requiredIds = @($requiredActions | ForEach-Object { [string]$_.id } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
$optionalIds = @($optionalActions | ForEach-Object { [string]$_.id } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
$mixedOptional = @($requiredIds | Where-Object { $optionalIds -contains $_ })
$commands = @($requiredActions | ForEach-Object { [string]$_.command })

$failures = New-Object System.Collections.Generic.List[string]
if (-not $approval) { $failures.Add("missing_latest_real_approval_plan") | Out-Null }
if ($approval.usedRealTraffic -ne $false) { $failures.Add("approval_plan_used_real_traffic") | Out-Null }
if ($approval.requestedRealTraffic -ne $false) { $failures.Add("approval_plan_requested_real_traffic") | Out-Null }
foreach ($gateId in $expectedRequiredGateIds) {
    if ($requiredGateIds -notcontains $gateId) { $failures.Add("missing_required_gate:$gateId") | Out-Null }
}
if ($requiredReleaseComplete) {
    foreach ($gateId in $expectedRequiredGateIds) {
        if ($completedRequiredGateIds -notcontains $gateId) { $failures.Add("missing_completed_required_gate:$gateId") | Out-Null }
    }
    if ($requiredActions.Count -gt 0) { $failures.Add("completed_release_still_has_required_actions") | Out-Null }
} elseif ($requiredActions.Count -lt 1) {
    $failures.Add("missing_required_actions") | Out-Null
}
if ($mixedOptional.Count -gt 0) { $failures.Add("optional_actions_mixed_into_required_sequence") | Out-Null }
foreach ($action in $requiredActions) {
    if ($action.requiresRealTraffic -ne $true) { $failures.Add("required_action_not_marked_real_traffic:$($action.id)") | Out-Null }
    if ($action.blockedUntilExplicitUserApproval -ne $true) { $failures.Add("required_action_not_approval_blocked:$($action.id)") | Out-Null }
    if ([string]::IsNullOrWhiteSpace([string]$action.command)) { $failures.Add("required_action_missing_command:$($action.id)") | Out-Null }
}

$payload = [ordered]@{
    ok = ($failures.Count -eq 0)
    reportName = "required-real-traffic-sequence"
    requestedRealTraffic = $false
    usedRealTraffic = $false
    behaviorCovered = $true
    coverageKind = "required-real-traffic-sequence-report-only"
    approvalPlanPath = $approvalPath
    approvalPlanPresent = ($null -ne $approval)
    approvalPlanReportName = [string]$approval.reportName
    requiredReleaseComplete = $requiredReleaseComplete
    requiredGateIds = $requiredGateIds
    completedRequiredGateIds = $completedRequiredGateIds
    requiredActionIds = $requiredIds
    optionalActionIds = $optionalIds
    requiredActionCount = $requiredActions.Count
    optionalActionCount = $optionalActions.Count
    noOptionalActionsInRequiredSequence = ($mixedOptional.Count -eq 0)
    blockedUntilExplicitUserApproval = (-not $requiredReleaseComplete -and $requiredActions.Count -gt 0 -and @($requiredActions | Where-Object { $_.blockedUntilExplicitUserApproval -ne $true }).Count -eq 0)
    commands = $commands
    failures = @($failures)
    elapsedMs = [int]([DateTime]::UtcNow - $startedAt).TotalMilliseconds
}

Write-Report ([pscustomobject]$payload)
Write-Output (($payload | ConvertTo-Json -Depth 20) -replace "\r?\n", "")
