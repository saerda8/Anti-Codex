#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$RuntimeRoot = $(Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)) "Anti-Codex\runtime"),
    [string]$ReportRoot = $(Join-Path $env:APPDATA "anticodex\reports"),
    [string]$BaseUrl = "",
    [switch]$NoPrompt,
    [switch]$SkipOpen,
    [switch]$SkipFullModelCheck,
    [switch]$AllowUnchanged
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not $BaseUrl) {
    $BaseUrl = & (Join-Path $PSScriptRoot "resolve-anticodex-base-url.ps1")
}

function Resolve-FullPath {
    param([string]$Path)
    try { return [IO.Path]::GetFullPath($Path) } catch { return [string]$Path }
}

$runtimeRootFull = Resolve-FullPath $RuntimeRoot
$scriptsRoot = Join-Path $runtimeRootFull "scripts"
$helper = Join-Path $scriptsRoot "antigravity-desktop.ps1"
$refresh = Join-Path $scriptsRoot "refresh-anticodex-models.ps1"
$check = Join-Path $scriptsRoot "test-anticodex-installed-overall.ps1"
$modelRouting = Join-Path $scriptsRoot "test-anticodex-model-routing.ps1"

foreach ($required in @($helper, $refresh, $check, $modelRouting)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "Anti-Codex account switch component is missing: $required"
    }
}

. $helper

function Write-Step {
    param([string]$Message)
    Write-Host "[Anti-Codex] $Message"
}

function New-ReportPaths {
    param([string]$Name)
    New-Item -ItemType Directory -Path $ReportRoot -Force | Out-Null
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    return [pscustomobject]@{
        latest = (Join-Path $ReportRoot "latest-$Name.json")
        history = (Join-Path $ReportRoot "$stamp-$Name.json")
    }
}

function Save-JsonReport {
    param($Paths, $Payload, [int]$Depth = 8)
    $json = $Payload | ConvertTo-Json -Depth $Depth -Compress
    $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
    . (Join-Path $PSScriptRoot "anticodex-report-io.ps1")
    Write-AntiCodexJsonReport -LatestPath $Paths.latest -HistoryPath $Paths.history -Json $json -Encoding $utf8NoBom
}

function Get-ModelSnapshot {
    try {
        $payload = Invoke-RestMethod -Uri "$BaseUrl/models" -Proxy $null -TimeoutSec 10
        $ids = @($payload.data | ForEach-Object { [string]$_.id } | Where-Object { $_ } | Sort-Object -Unique)
        $fingerprintSource = $ids -join "`n"
        $fingerprintBytes = [Text.Encoding]::UTF8.GetBytes($fingerprintSource)
        $sha256 = [Security.Cryptography.SHA256]::Create()
        try {
            $fingerprint = ([BitConverter]::ToString($sha256.ComputeHash($fingerprintBytes))).Replace("-", "").ToLowerInvariant()
        } finally {
            $sha256.Dispose()
        }
        return [pscustomobject]@{
            ok = $true
            capturedAt = [DateTime]::UtcNow.ToString("o")
            count = $ids.Count
            ids = $ids
            fingerprint = $fingerprint
            error = $null
        }
    } catch {
        return [pscustomobject]@{
            ok = $false
            capturedAt = [DateTime]::UtcNow.ToString("o")
            count = 0
            ids = @()
            fingerprint = ""
            error = $_.Exception.Message
        }
    }
}

function Get-AccountSnapshot {
    try {
        $payload = Invoke-RestMethod -Uri "$BaseUrl/anticodex/account" -Proxy $null -TimeoutSec 10
        return [pscustomobject]@{
            ok = $true
            capturedAt = [DateTime]::UtcNow.ToString("o")
            signedIn = [bool]$payload.signedIn
            identityAvailable = [bool]$payload.identityAvailable
            fingerprint = [string]$payload.fingerprint
            planName = [string]$payload.planName
            tierName = [string]$payload.tierName
            error = $null
        }
    } catch {
        return [pscustomobject]@{
            ok = $false
            capturedAt = [DateTime]::UtcNow.ToString("o")
            signedIn = $false
            identityAvailable = $false
            fingerprint = ""
            planName = ""
            tierName = ""
            error = $_.Exception.Message
        }
    }
}

$startedAt = [DateTime]::UtcNow
$steps = New-Object System.Collections.Generic.List[string]
$beforeAccount = Get-AccountSnapshot
$steps.Add("captured-before-account") | Out-Null
$beforeModels = Get-ModelSnapshot
$steps.Add("captured-before-models") | Out-Null

if (-not $SkipOpen) {
    $desktopPath = Resolve-AntigravityDesktopPath
    if (-not $desktopPath) {
        throw "Antigravity Desktop was not found. Install or start Antigravity, then retry."
    }

    $running = Get-AntigravityMainProcess -ExecutablePath $desktopPath
    if (-not $running) {
        Write-Step "Starting Antigravity Desktop..."
        $steps.Add("started-antigravity-desktop") | Out-Null
        Start-Process -FilePath $desktopPath | Out-Null
        $stable = Wait-AntigravityDesktopStable -ExecutablePath $desktopPath -TimeoutSeconds 60 -StableSeconds 3
        if (-not $stable.Stable) {
            throw "Antigravity Desktop did not become stable within 60 seconds."
        }
    } else {
        Write-Step "Antigravity Desktop is already running."
        $steps.Add("focused-antigravity-desktop") | Out-Null
        Start-Process -FilePath $desktopPath | Out-Null
    }
}

if (-not $NoPrompt) {
    Write-Host ""
    Write-Host "Switch or sign in to the desired account inside Antigravity Desktop."
    Write-Host "After Antigravity shows the account and model menu you want Anti-Codex to use, return here."
    Read-Host "Press Enter to refresh Anti-Codex models and run the installed check"
}

Write-Step "Refreshing Anti-Codex models from the signed-in Antigravity account..."
& $refresh
if ($? -ne $true) {
    throw "Anti-Codex model refresh failed."
}
$steps.Add("refreshed-models") | Out-Null

$afterModels = Get-ModelSnapshot
$steps.Add("captured-after-models") | Out-Null
$afterAccount = Get-AccountSnapshot
$steps.Add("captured-after-account") | Out-Null
$addedModels = @($afterModels.ids | Where-Object { $beforeModels.ids -notcontains $_ })
$removedModels = @($beforeModels.ids | Where-Object { $afterModels.ids -notcontains $_ })
$catalogChanged = $beforeModels.ok -and $afterModels.ok -and ($beforeModels.fingerprint -ne $afterModels.fingerprint)
$identityComparable = $beforeAccount.ok -and $afterAccount.ok -and
    $beforeAccount.identityAvailable -and $afterAccount.identityAvailable
$accountChanged = $identityComparable -and
    ($beforeAccount.fingerprint -ne $afterAccount.fingerprint)

if (-not $SkipFullModelCheck) {
    Write-Step "Verifying every model visible to the current Antigravity account..."
    & $modelRouting -BaseUrl $BaseUrl -ReportRoot $ReportRoot -SkipRefresh
    if ($? -ne $true) {
        throw "Anti-Codex full model routing verification failed after account switch."
    }
    $steps.Add("verified-all-models") | Out-Null
}

Write-Step "Running Anti-Codex installed check..."
& $check -BaseUrl $BaseUrl -ReportRoot $ReportRoot
if ($? -ne $true) {
    throw "Anti-Codex installed check failed."
}
$steps.Add("ran-installed-check") | Out-Null

$endedAt = [DateTime]::UtcNow
$reportPaths = New-ReportPaths "account-switch"
$result = [pscustomobject]@{
    ok = [bool]($AllowUnchanged -or $accountChanged)
    elapsedMs = [int]($endedAt - $startedAt).TotalMilliseconds
    noPrompt = [bool]$NoPrompt
    skipOpen = [bool]$SkipOpen
    skipFullModelCheck = [bool]$SkipFullModelCheck
    allowUnchanged = [bool]$AllowUnchanged
    accountChangeRequired = -not [bool]$AllowUnchanged
    runtimeRoot = $runtimeRootFull
    steps = $steps.ToArray()
    accountIdentity = [pscustomobject]@{
        changed = $accountChanged
        comparable = $identityComparable
        proof = if (-not $beforeAccount.ok) {
            "before_account_snapshot_unavailable"
        } elseif (-not $afterAccount.ok) {
            "after_account_snapshot_unavailable"
        } elseif (-not $beforeAccount.identityAvailable) {
            "before_account_identity_unavailable"
        } elseif (-not $afterAccount.identityAvailable) {
            "after_account_identity_unavailable"
        } elseif ($accountChanged) {
            "account_identity_changed"
        } else {
            "account_identity_unchanged"
        }
        note = if ($accountChanged) {
            "The anonymized Antigravity account fingerprint changed."
        } elseif ($identityComparable) {
            "The anonymized Antigravity account fingerprint did not change."
        } else {
            "Antigravity did not expose enough account identity data to prove whether the account changed."
        }
        before = $beforeAccount
        after = $afterAccount
    }
    modelCatalog = [pscustomobject]@{
        changed = $catalogChanged
        proof = if (-not $beforeModels.ok) {
            "before_snapshot_unavailable"
        } elseif (-not $afterModels.ok) {
            "after_snapshot_unavailable"
        } elseif ($catalogChanged) {
            "model_catalog_changed"
        } else {
            "model_catalog_unchanged"
        }
        note = if ($catalogChanged) {
            "The visible Antigravity model catalog changed after the account workflow."
        } else {
            "The visible model catalog did not change. Accounts may expose the same models, so model IDs alone cannot prove account identity changed."
        }
        before = $beforeModels
        after = $afterModels
        added = $addedModels
        removed = $removedModels
    }
    fullModelRoutingReport = if ($SkipFullModelCheck) { $null } else { (Join-Path $ReportRoot "latest-model-routing.json") }
    installedOverallReport = (Join-Path $ReportRoot "latest-installed-overall.json")
    report = $reportPaths
}
Save-JsonReport $reportPaths $result
$result | ConvertTo-Json -Depth 8 -Compress
if (-not $AllowUnchanged -and -not $accountChanged) {
    if ($identityComparable) {
        throw "Antigravity account did not change. Select a different account in Antigravity Desktop, then run the account switch again."
    }
    throw "Anti-Codex could not verify that the Antigravity account changed. Reopen Antigravity Desktop, confirm the desired account, then run the account switch again."
}
Write-Step "Account switch check completed."


