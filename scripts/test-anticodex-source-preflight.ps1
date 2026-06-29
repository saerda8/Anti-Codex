[CmdletBinding()]
param(
    [string]$SourceRoot = "",
    [string]$ReportRoot = "",
    [int]$SubcheckTimeoutSec = 120,
    [switch]$SkipFullRegression
)

$ErrorActionPreference = "Stop"
if (-not $SourceRoot) {
    $SourceRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}
if (-not $ReportRoot) {
    $ReportRoot = Join-Path $env:APPDATA "anticodex\reports"
}
$startedAt = [DateTime]::UtcNow
$failures = New-Object System.Collections.Generic.List[string]
$warnings = New-Object System.Collections.Generic.List[string]
$checks = [ordered]@{}

function Add-Failure {
    param([string]$Message)
    $failures.Add($Message) | Out-Null
}

function Add-Warning {
    param([string]$Message)
    $warnings.Add($Message) | Out-Null
}

function Normalize-Path {
    param([string]$Path)
    if (-not $Path) { return "" }
    return [IO.Path]::GetFullPath($Path)
}

function Get-RelativeSourcePath {
    param([string]$Path)
    $root = Normalize-Path $SourceRoot
    $full = Normalize-Path $Path
    if (-not $root.EndsWith([IO.Path]::DirectorySeparatorChar)) {
        $root = "$root$([IO.Path]::DirectorySeparatorChar)"
    }
    if ($full.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {
        return $full.Substring($root.Length)
    }
    return $full
}

function Read-TextSafe {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return "" }
    try { return [IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8) } catch { return "" }
}

function Invoke-SourceProcess {
    param(
        [string]$Name,
        [string]$FilePath,
        [string[]]$Arguments,
        [int]$TimeoutSec = $SubcheckTimeoutSec
    )

    $stdoutPath = [IO.Path]::GetTempFileName()
    $stderrPath = [IO.Path]::GetTempFileName()
    $checkStartedAt = [DateTime]::UtcNow
    try {
        $process = Start-Process -FilePath $FilePath `
            -ArgumentList $Arguments `
            -WorkingDirectory $SourceRoot `
            -NoNewWindow `
            -PassThru `
            -RedirectStandardOutput $stdoutPath `
            -RedirectStandardError $stderrPath
        [void]$process.Handle
        $deadline = [DateTime]::UtcNow.AddSeconds([Math]::Max(1, $TimeoutSec))
        while (-not $process.HasExited -and [DateTime]::UtcNow -lt $deadline) {
            Start-Sleep -Milliseconds 200
            try { $process.Refresh() } catch {}
        }
        $timedOut = -not $process.HasExited
        if ($timedOut) {
            try { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue } catch {}
            Start-Sleep -Milliseconds 200
        }
        $stdout = Read-TextSafe $stdoutPath
        $stderr = Read-TextSafe $stderrPath
        $exitCode = if ($timedOut) { -1 } else { [int]$process.ExitCode }
        $durationMs = [int]([DateTime]::UtcNow - $checkStartedAt).TotalMilliseconds
        return [pscustomobject]@{
            ok = (-not $timedOut -and $exitCode -eq 0)
            name = $Name
            exitCode = $exitCode
            timedOut = $timedOut
            durationMs = $durationMs
            stdoutTail = (($stdout -split "\r?\n") | Select-Object -Last 40)
            stderrTail = (($stderr -split "\r?\n") | Select-Object -Last 40)
        }
    } finally {
        Remove-Item -LiteralPath $stdoutPath, $stderrPath -Force -ErrorAction SilentlyContinue
    }
}

function Test-JavaScriptSyntax {
    $node = (Get-Command "node" -ErrorAction Stop).Source
    $scanRoots = @("translator", "scripts")
    $files = @($scanRoots | ForEach-Object {
        $scanRoot = Join-Path $SourceRoot $_
        if (Test-Path -LiteralPath $scanRoot -PathType Container) {
            Get-ChildItem -LiteralPath $scanRoot -Recurse -File | Where-Object {
            $_.Extension -in @(".mjs", ".js") -and $_.FullName -notmatch '\\node_modules\\'
        } | ForEach-Object {
                Get-RelativeSourcePath $_.FullName
            }
        }
    } | Sort-Object -Unique)
    $items = New-Object System.Collections.Generic.List[object]
    foreach ($relative in $files) {
        $path = Join-Path $SourceRoot $relative
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            $items.Add([pscustomobject]@{ file = $relative; ok = $false; missing = $true }) | Out-Null
            Add-Failure "JavaScript syntax file missing: $relative"
            continue
        }
        $result = Invoke-SourceProcess -Name "node --check $relative" -FilePath $node -Arguments @("--check", $path) -TimeoutSec 30
        $items.Add([pscustomobject]@{ file = $relative; ok = $result.ok; exitCode = $result.exitCode; timedOut = $result.timedOut }) | Out-Null
        if (-not $result.ok) { Add-Failure "JavaScript syntax check failed: $relative" }
    }
    $failedItems = @($items | Where-Object { -not [bool]$_.ok })
    $ok = ($failedItems.Count -eq 0)
    $itemArray = @($items.ToArray())
    return [pscustomobject]@{
        ok = $ok
        files = $itemArray
    }
}

function Test-PowerShellSyntax {
    $files = @(Get-ChildItem -LiteralPath (Join-Path $SourceRoot "scripts") -Filter "*.ps1" -File | Sort-Object FullName)
    $bad = New-Object System.Collections.Generic.List[object]
    foreach ($file in $files) {
        $tokens = $null
        $errors = $null
        [System.Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$tokens, [ref]$errors) | Out-Null
        if ($errors -and $errors.Count -gt 0) {
            $bad.Add([pscustomobject]@{
                file = $file.Name
                errors = @($errors | ForEach-Object { $_.Message })
            }) | Out-Null
        }
    }
    if ($bad.Count -gt 0) { Add-Failure "PowerShell parser found $($bad.Count) script(s) with syntax errors" }
    $badArray = @($bad.ToArray())
    return [pscustomobject]@{
        ok = ($bad.Count -eq 0)
        parsed = $files.Count
        failures = $badArray
    }
}

function Test-UiStateSelfTest {
    $node = (Get-Command "node" -ErrorAction Stop).Source
    $script = Join-Path $SourceRoot "scripts\test-anticodex-ui-state.mjs"
    $result = Invoke-SourceProcess -Name "UI state self-test" -FilePath $node -Arguments @($script, "--self-test") -TimeoutSec 30
    if (-not $result.ok) { Add-Failure "UI state self-test failed" }
    return $result
}

function Test-ManagerBridgeSelfTest {
    $node = (Get-Command "node" -ErrorAction Stop).Source
    $script = Join-Path $SourceRoot "scripts\anticodex-manager-bridge.mjs"
    $result = Invoke-SourceProcess -Name "Manager bridge self-test" -FilePath $node -Arguments @($script, "--self-test") -TimeoutSec 30
    if (-not $result.ok) { Add-Failure "Manager bridge self-test failed" }
    return $result
}

function Test-LogDbGuardSelfTest {
    $node = (Get-Command "node" -ErrorAction Stop).Source
    $script = Join-Path $SourceRoot "scripts\protect-anticodex-log-db.mjs"
    $result = Invoke-SourceProcess -Name "log database guard self-test" -FilePath $node -Arguments @($script, "--self-test") -TimeoutSec 30
    if (-not $result.ok) { Add-Failure "Log database guard self-test failed" }
    return $result
}

function Test-UpstreamProfileStorage {
    $powershell = (Get-Command "powershell.exe" -ErrorAction Stop).Source
    $script = Join-Path $SourceRoot "scripts\test-anticodex-upstream-profile.ps1"
    $result = Invoke-SourceProcess `
        -Name "upstream profile storage" `
        -FilePath $powershell `
        -Arguments @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $script) `
        -TimeoutSec 30
    if (-not $result.ok) { Add-Failure "Upstream profile storage test failed" }
    return $result
}

function Test-AntigravityCliIsolationProfile {
    $powershell = (Get-Command "powershell.exe" -ErrorAction Stop).Source
    $script = Join-Path $SourceRoot "scripts\test-anticodex-antigravity-cli-isolation.ps1"
    $result = Invoke-SourceProcess `
        -Name "Antigravity CLI isolation profile" `
        -FilePath $powershell `
        -Arguments @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $script, "-ReportRoot", $ReportRoot) `
        -TimeoutSec 30
    $isolationJson = ($result.stdoutTail -join "`n")
    $isolationOk = $false
    $isolationContract = [ordered]@{
        ok = $false
        usedRealTraffic = $false
        loginVerified = $false
        separateAccountVerified = $false
        accountLaneRole = ""
        mcpAccountLaneManagedByAntiCodex = $true
        mcpAccountLaneOwner = ""
        accountIsolationBoundary = ""
        accountIsolationCaveat = ""
    }
    if ($result.ok -and $isolationJson) {
        try {
            $parsed = $isolationJson | ConvertFrom-Json
            $isolationContract.ok = [bool]$parsed.ok
            $isolationContract.usedRealTraffic = [bool]$parsed.usedRealTraffic
            $isolationContract.loginVerified = [bool]$parsed.loginVerified
            $isolationContract.separateAccountVerified = [bool]$parsed.separateAccountVerified
            $isolationContract.accountLaneRole = [string]$parsed.accountLaneRole
            $isolationContract.mcpAccountLaneManagedByAntiCodex = [bool]$parsed.mcpAccountLaneManagedByAntiCodex
            $isolationContract.mcpAccountLaneOwner = [string]$parsed.mcpAccountLaneOwner
            $isolationContract.accountIsolationBoundary = [string]$parsed.accountIsolationBoundary
            $isolationContract.accountIsolationCaveat = [string]$parsed.accountIsolationCaveat
            $isolationOk = $parsed.ok -eq $true `
                -and $parsed.usedRealTraffic -eq $false `
                -and $parsed.loginVerified -eq $false `
                -and $parsed.separateAccountVerified -eq $false `
                -and $parsed.accountLaneRole -eq "anticodex-model-text" `
                -and $parsed.mcpAccountLaneManagedByAntiCodex -eq $false `
                -and $parsed.mcpAccountLaneOwner -eq "external-antigravity-account-not-managed-here" `
                -and $parsed.accountIsolationBoundary `
                -and $parsed.accountIsolationCaveat
        } catch {
            Add-Failure "Antigravity CLI isolation profile JSON parse failed"
        }
    }
    if (-not $isolationOk -and $result.ok) {
        Add-Failure "Antigravity CLI isolation profile contract not satisfied"
    }
    if (-not $result.ok) { Add-Failure "Antigravity CLI isolation profile test failed" }
    return [pscustomobject]@{
        ok = $isolationOk
        name = "Antigravity CLI isolation profile"
        exitCode = $result.exitCode
        timedOut = $result.timedOut
        durationMs = $result.durationMs
        usedRealTraffic = $false
        loginVerified = $false
        separateAccountVerified = $false
        accountLaneRole = $isolationContract.accountLaneRole
        mcpAccountLaneManagedByAntiCodex = $isolationContract.mcpAccountLaneManagedByAntiCodex
        mcpAccountLaneOwner = $isolationContract.mcpAccountLaneOwner
        accountIsolationBoundary = $isolationContract.accountIsolationBoundary
        accountIsolationCaveat = $isolationContract.accountIsolationCaveat
        contract = $isolationContract
    }
}

function Test-AntigravityCliProfilePrepare {
    $powershell = (Get-Command "powershell.exe" -ErrorAction Stop).Source
    $script = Join-Path $SourceRoot "scripts\prepare-anticodex-antigravity-cli-profile.ps1"
    $tempStateRoot = Join-Path ([IO.Path]::GetTempPath()) ("anticodex-srcpreflight-state-" + [Guid]::NewGuid().ToString("N"))
    $tempReportRoot = Join-Path ([IO.Path]::GetTempPath()) ("anticodex-srcpreflight-report-" + [Guid]::NewGuid().ToString("N"))
    $tempProfileRoot = Join-Path ([IO.Path]::GetTempPath()) ("anticodex-srcpreflight-profile-" + [Guid]::NewGuid().ToString("N"))
    try {
        $result = Invoke-SourceProcess `
            -Name "Antigravity CLI profile prepare (no-traffic)" `
            -FilePath $powershell `
            -Arguments @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $script,
                "-StateRoot", $tempStateRoot,
                "-ReportRoot", $tempReportRoot,
                "-ProfileRoot", $tempProfileRoot,
                "-NoSaveProfile") `
            -TimeoutSec 30
        $prepareJson = ($result.stdoutTail -join "`n")
        $prepareOk = $false
        $prepareContract = [ordered]@{
            ok = $false
            usedRealTraffic = $false
            loginVerified = $false
            separateAccountVerified = $false
            accountLaneRole = ""
            mcpAccountLaneManagedByAntiCodex = $true
            mcpAccountLaneOwner = ""
            coverageKind = "missing"
            accountIsolationBoundary = ""
            accountIsolationCaveat = ""
        }
        if ($result.ok -and $prepareJson) {
            try {
                $parsed = $prepareJson | ConvertFrom-Json
                $prepareContract.ok = [bool]$parsed.ok
                $prepareContract.usedRealTraffic = [bool]$parsed.usedRealTraffic
                $prepareContract.loginVerified = [bool]$parsed.loginVerified
                $prepareContract.separateAccountVerified = [bool]$parsed.separateAccountVerified
                $prepareContract.accountLaneRole = [string]$parsed.accountLaneRole
                $prepareContract.mcpAccountLaneManagedByAntiCodex = [bool]$parsed.mcpAccountLaneManagedByAntiCodex
                $prepareContract.mcpAccountLaneOwner = [string]$parsed.mcpAccountLaneOwner
                $prepareContract.coverageKind = [string]$parsed.coverageKind
                $prepareContract.accountIsolationBoundary = [string]$parsed.accountIsolationBoundary
                $prepareContract.accountIsolationCaveat = [string]$parsed.accountIsolationCaveat
                $prepareOk = $parsed.ok -eq $true `
                    -and $parsed.usedRealTraffic -eq $false `
                    -and $parsed.loginVerified -eq $false `
                    -and $parsed.separateAccountVerified -eq $false `
                    -and $parsed.accountLaneRole -eq "anticodex-model-text" `
                    -and $parsed.mcpAccountLaneManagedByAntiCodex -eq $false `
                    -and $parsed.mcpAccountLaneOwner -eq "external-antigravity-account-not-managed-here" `
                    -and $parsed.coverageKind -eq "profile-prepared-no-traffic" `
                    -and $parsed.accountIsolationBoundary `
                    -and $parsed.accountIsolationCaveat
            } catch {
                Add-Failure "Antigravity CLI profile prepare JSON parse failed"
            }
        }
        if (-not $prepareOk -and $result.ok) {
            Add-Failure "Antigravity CLI profile prepare contract not satisfied"
        }
        if (-not $result.ok) { Add-Failure "Antigravity CLI profile prepare failed" }
        return [pscustomobject]@{
            ok = $prepareOk
            name = "Antigravity CLI profile prepare (no-traffic)"
            exitCode = $result.exitCode
            timedOut = $result.timedOut
            durationMs = $result.durationMs
            usedRealTraffic = $false
            loginVerified = $false
            separateAccountVerified = $false
            accountLaneRole = $prepareContract.accountLaneRole
            mcpAccountLaneManagedByAntiCodex = $prepareContract.mcpAccountLaneManagedByAntiCodex
            mcpAccountLaneOwner = $prepareContract.mcpAccountLaneOwner
            coverageKind = $prepareContract.coverageKind
            accountIsolationBoundary = $prepareContract.accountIsolationBoundary
            accountIsolationCaveat = $prepareContract.accountIsolationCaveat
            contract = $prepareContract
        }
    } finally {
        Remove-Item -LiteralPath $tempStateRoot, $tempReportRoot, $tempProfileRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Test-LocalConnectorVerifier {
    $node = (Get-Command "node" -ErrorAction Stop).Source
    $script = Join-Path $SourceRoot "scripts\test-anticodex-local-connectors.mjs"
    $timeoutMs = [Math]::Max(10000, $SubcheckTimeoutSec * 1000)
    $result = Invoke-SourceProcess `
        -Name "local connector/app-tool verifier" `
        -FilePath $node `
        -Arguments @($script, "--source-root", $SourceRoot, "--runtime-root", $SourceRoot, "--report-root", $ReportRoot, "--timeout-ms", "$timeoutMs") `
        -TimeoutSec $SubcheckTimeoutSec
    if (-not $result.ok) { Add-Failure "Local connector/app-tool verifier failed" }
    return $result
}

function Test-TranslatorRegression {
    if ($SkipFullRegression) {
        return [pscustomobject]@{ ok = $true; skipped = $true; reason = "SkipFullRegression" }
    }
    $node = (Get-Command "node" -ErrorAction Stop).Source
    $testFiles = @(Get-ChildItem -LiteralPath (Join-Path $SourceRoot "translator\tests") -Filter "*.test.mjs" -File | Sort-Object FullName | ForEach-Object { $_.FullName })
    if ($testFiles.Count -eq 0) {
        Add-Failure "No translator test files found"
        return [pscustomobject]@{ ok = $false; testFiles = 0 }
    }
    $result = Invoke-SourceProcess -Name "translator source regression" -FilePath $node -Arguments (@("--test") + $testFiles) -TimeoutSec $SubcheckTimeoutSec
    if (-not $result.ok) { Add-Failure "Translator source regression failed" }
    $summary = ($result.stdoutTail + $result.stderrTail) -join "`n"
    return [pscustomobject]@{
        ok = $result.ok
        exitCode = $result.exitCode
        timedOut = $result.timedOut
        durationMs = $result.durationMs
        testFiles = $testFiles.Count
        tail = $result.stdoutTail
        tests = ([regex]::Match($summary, 'tests\s+(\d+)').Groups[1].Value)
        pass = ([regex]::Match($summary, 'pass\s+(\d+)').Groups[1].Value)
        fail = ([regex]::Match($summary, 'fail\s+(\d+)').Groups[1].Value)
        skipped = ([regex]::Match($summary, 'skipped\s+(\d+)').Groups[1].Value)
    }
}

function Test-PublicDocumentationContracts {
    $assertions = New-Object System.Collections.Generic.List[object]

    function Add-DocAssertion {
        param(
            [string]$File,
            [string]$Name,
            [bool]$Ok
        )
        $assertions.Add([pscustomobject]@{ file = $File; name = $Name; ok = $Ok }) | Out-Null
        if (-not $Ok) { Add-Failure "public documentation contract failed: $File $Name" }
    }

    function Read-PublicDoc {
        param([string]$Relative)
        $path = Join-Path $SourceRoot $Relative
        $text = Read-TextSafe $path
        Add-DocAssertion -File $Relative -Name "exists-and-readable" -Ok ([bool]$text)
        return $text
    }

    $readme = Read-PublicDoc "README.md"
    $readmeEn = Read-PublicDoc "README_EN.md"
    $windowsDoc = Read-PublicDoc "docs\WINDOWS.md"
    $providerStack = Read-PublicDoc "docs\ADAPTIVE_ONE_API_STACK.md"
    $compatibility = Read-PublicDoc "docs\chat-to-responses-compat.md"
    $legacyMarketing = Read-PublicDoc "docs\marketing\legacy\deepcodex-video-script.md"
    $marketingDocs = @(
        (Read-PublicDoc "docs\marketing\launch-post.md"),
        (Read-PublicDoc "docs\marketing\video-script.md"),
        (Read-PublicDoc "docs\marketing\wechat-article.md")
    ) -join "`n`n"

    Add-DocAssertion -File "README.md" -Name "anti-codex-brand" -Ok ($readme -match '^# Anti-Codex')
    Add-DocAssertion -File "README.md" -Name "client-copy-sync-contract" -Ok ($readme -match 'client-copy sync' -and $readme -match 'feature-by-feature rebuild')
    Add-DocAssertion -File "README.md" -Name "antigravity-entitlement-model-text" -Ok ($readme -match 'Antigravity' -and $readme -match 'Anti-Codex/Codex')
    Add-DocAssertion -File "README.md" -Name "third-party-profile-boundary" -Ok ($readme -match 'upstream profile')
    Add-DocAssertion -File "README.md" -Name "connector-authorization-boundary" -Ok ($readme -match 'connector-backed app tools')
    Add-DocAssertion -File "README.md" -Name "no-old-public-launch-claims" -Ok ($readme -notmatch 'DeepCodex app|DeepCodex launched successfully|DeepCodex for Windows is|DeepCodex\.lnk')
    Add-DocAssertion -File "README_EN.md" -Name "anti-codex-brand" -Ok ($readmeEn -match '^# Anti-Codex')
    Add-DocAssertion -File "README_EN.md" -Name "client-copy-sync-contract" -Ok ($readmeEn -match 'guarded client sync' -and $readmeEn -match 'not a feature-by-feature reimplementation')
    Add-DocAssertion -File "README_EN.md" -Name "antigravity-entitlement-model-text" -Ok ($readmeEn -match 'Antigravity entitlement' -and $readmeEn -match 'Codex-owned tools stay in Anti-Codex')
    Add-DocAssertion -File "README_EN.md" -Name "third-party-profile-boundary" -Ok ($readmeEn -match 'upstream profile')
    Add-DocAssertion -File "README_EN.md" -Name "connector-authorization-boundary" -Ok ($readmeEn -match 'Connector-backed app tools')
    Add-DocAssertion -File "README_EN.md" -Name "no-old-public-launch-claims" -Ok ($readmeEn -notmatch 'DeepCodex app|DeepCodex launched successfully|DeepCodex for Windows is|DeepCodex\.lnk')

    Add-DocAssertion -File "docs\ADAPTIVE_ONE_API_STACK.md" -Name "provider-stack-title" -Ok ($providerStack -match '^# Anti-Codex provider stack')
    Add-DocAssertion -File "docs\ADAPTIVE_ONE_API_STACK.md" -Name "antigravity-entitlement-model-text" -Ok ($providerStack -match 'Antigravity entitlement supplies model text')
    Add-DocAssertion -File "docs\ADAPTIVE_ONE_API_STACK.md" -Name "third-party-provider" -Ok ($providerStack -match 'optional third-party provider profile')
    Add-DocAssertion -File "docs\ADAPTIVE_ONE_API_STACK.md" -Name "connector-boundary" -Ok ($providerStack -match 'Metadata parity does not grant connector authorization')
    Add-DocAssertion -File "docs\ADAPTIVE_ONE_API_STACK.md" -Name "no-old-one-api-default" -Ok ($providerStack -notmatch '# deepcodex adaptive one-api|deepcodex\.app|setup-one-api-minimal|start-adaptive-oneapi|creates or updates a `deepcodex`')

    Add-DocAssertion -File "docs\chat-to-responses-compat.md" -Name "anti-codex-scope" -Ok ($compatibility -match 'Scope: Anti-Codex translates Codex Desktop')
    Add-DocAssertion -File "docs\chat-to-responses-compat.md" -Name "antigravity-entitlement-model-text" -Ok ($compatibility -match 'Antigravity entitlement supplies model text')
    Add-DocAssertion -File "docs\chat-to-responses-compat.md" -Name "provider-shapes" -Ok ($compatibility -match 'OpenAI-compatible third-party providers' -and $compatibility -match 'Anthropic-compatible third-party providers')
    Add-DocAssertion -File "docs\chat-to-responses-compat.md" -Name "connector-boundary" -Ok ($compatibility -match 'Connector/app-tool metadata parity must not be treated as authorization')
    Add-DocAssertion -File "docs\chat-to-responses-compat.md" -Name "legacy-prefix-is-internal" -Ok ($compatibility -match 'deepcodex\.reasoning\.hex\.v1:<hex>' -and $compatibility -match 'internal compatibility token')
    Add-DocAssertion -File "docs\chat-to-responses-compat.md" -Name "no-old-deepseek-scope" -Ok ($compatibility -notmatch 'Scope: deepcodex|DeepSeek route|DeepSeek-specific|Current Deepcodex Gaps|Deepcodex should')

    Add-DocAssertion -File "docs\marketing\*.md" -Name "anti-codex-brand" -Ok ($marketingDocs -match 'Anti-Codex')
    Add-DocAssertion -File "docs\marketing\*.md" -Name "provider-language" -Ok ($marketingDocs -match 'Antigravity' -and $marketingDocs -match 'third-party|provider|OpenAI-compatible|Anthropic API')
    Add-DocAssertion -File "docs\marketing\*.md" -Name "connector-boundary" -Ok ($marketingDocs -match 'connector|app tool' -and $marketingDocs -match 'does not fake authorization')
    Add-DocAssertion -File "docs\marketing\*.md" -Name "no-current-legacy-marketing" -Ok ($marketingDocs -notmatch 'DeepCodex|deepcodex|DeepSeek-only|DeepSeek route|DeepSeek API key')
    $currentPublicDocs = @($readme, $readmeEn, $providerStack, $compatibility, $marketingDocs) -join "`n"
    $currentCliBoundaryDocs = @($readme, $readmeEn, $windowsDoc) -join "`n"
    $hasAntigravityCliTarget = $currentCliBoundaryDocs -match 'Antigravity CLI'
    $hasDesktopCoworkerBoundary = $currentCliBoundaryDocs -match 'Desktop/coworker'
    $hasCompatibilityLayerBoundary = $currentCliBoundaryDocs -match 'compatibility layer'
    $cliTargetDesktopCompatBoundaryOk = $hasAntigravityCliTarget -and $hasDesktopCoworkerBoundary -and $hasCompatibilityLayerBoundary
    $noDesktopDefaultPattern = 'Antigravity Desktop provider|Antigravity Desktop is the default|Antigravity Desktop remains the default route|default route remains the local signed-in Antigravity Desktop account|Antigravity Desktop by default'
    $noNativeBridgeDefaultPattern = 'native same-cascade MCP continuation'
    $noAntigravityDesktopDefaultRouteOk = $currentPublicDocs -notmatch $noDesktopDefaultPattern
    $noNativeBridgeDefaultWordingOk = $currentPublicDocs -notmatch $noNativeBridgeDefaultPattern
    Add-DocAssertion -File "current public docs" -Name "no-antigravity-desktop-default-route" -Ok $noAntigravityDesktopDefaultRouteOk
    Add-DocAssertion -File "current public docs" -Name "antigravity-cli-target-desktop-compat-boundary" -Ok $cliTargetDesktopCompatBoundaryOk
    Add-DocAssertion -File "current public docs" -Name "no-native-bridge-default-wording" -Ok $noNativeBridgeDefaultWordingOk
    Add-DocAssertion -File "docs\marketing\legacy\deepcodex-video-script.md" -Name "legacy-marker" -Ok ($legacyMarketing -match 'archived historical DeepCodex / DeepSeek launch material' -and $legacyMarketing -match 'not a current Anti-Codex launch asset')

    $legacyDeepseekNotes = Read-PublicDoc "docs\DEEPSEEK_RUNTIME_FAILURE_NOTES.md"
    Add-DocAssertion -File "docs\DEEPSEEK_RUNTIME_FAILURE_NOTES.md" -Name "no-stale-antigravity-desktop-default-provider" -Ok ($legacyDeepseekNotes -notmatch 'defaults to the local Antigravity Desktop provider')
    Add-DocAssertion -File "docs\DEEPSEEK_RUNTIME_FAILURE_NOTES.md" -Name "legacy-current-boundary-wording" -Ok ($legacyDeepseekNotes -match 'legacy route notes' -and $legacyDeepseekNotes -match 'not the current Anti-Codex default provider')

    $failed = @($assertions.ToArray() | Where-Object { -not [bool]$_.ok })
    return [pscustomobject]@{
        ok = ($failed.Count -eq 0)
        assertions = @($assertions.ToArray())
        failed = $failed
    }
}

function Test-GitDiffCheck {
    $gitCommand = Get-Command "git" -ErrorAction SilentlyContinue
    if (-not $gitCommand) {
        Add-Warning "git not found; skipped diff whitespace check"
        return [pscustomobject]@{ ok = $true; skipped = $true; reason = "git not found" }
    }
    $workTreeResult = Invoke-SourceProcess -Name "git rev-parse --is-inside-work-tree" -FilePath $gitCommand.Source -Arguments @("-C", $sourceRoot, "rev-parse", "--is-inside-work-tree") -TimeoutSec 10
    $insideWorkTree = (($workTreeResult.stdoutTail + $workTreeResult.stderrTail) | Where-Object { $_ } | Select-Object -First 1)
    if (-not $workTreeResult.ok -or [string]$insideWorkTree -ne "true") {
        Add-Warning "not a git worktree; skipped diff whitespace check"
        return [pscustomobject]@{ ok = $true; skipped = $true; reason = "not a git worktree" }
    }
    $result = Invoke-SourceProcess -Name "git diff --check" -FilePath $gitCommand.Source -Arguments @("-C", $sourceRoot, "diff", "--check") -TimeoutSec 30
    $lines = @($result.stdoutTail + $result.stderrTail | Where-Object { $_ })
    $nonWarningLines = @($lines | Where-Object {
        $_ -notmatch '^warning: in the working copy of .*, LF will be replaced by CRLF the next time Git touches it$'
    })
    if (-not $result.ok -and $nonWarningLines.Count -eq 0) {
        foreach ($line in $lines) { Add-Warning $line }
        return [pscustomobject]@{
            ok = $true
            exitCode = $result.exitCode
            warningsOnly = $true
            warningCount = $lines.Count
            warnings = $lines
        }
    }
    if (-not $result.ok) {
        Add-Failure "git diff --check reported whitespace errors"
    }
    return [pscustomobject]@{
        ok = $result.ok
        exitCode = $result.exitCode
        warningsOnly = $false
        output = $lines
    }
}

function New-ReportPaths {
    param([string]$Name)
    New-Item -ItemType Directory -Path $ReportRoot -Force | Out-Null
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    return [pscustomobject]@{
        latest = Join-Path $ReportRoot "latest-$Name.json"
        history = Join-Path $ReportRoot "$stamp-$Name.json"
    }
}

function Save-JsonReport {
    param([string]$Name, $Payload)
    $paths = New-ReportPaths $Name
    $json = $Payload | ConvertTo-Json -Depth 24
    $encoding = [System.Text.UTF8Encoding]::new($false)
    . (Join-Path $PSScriptRoot "anticodex-report-io.ps1")
    Write-AntiCodexJsonReport -LatestPath $paths.latest -HistoryPath $paths.history -Json $json -Encoding $encoding
    return $paths
}

try {
    $checks["javascriptSyntax"] = Test-JavaScriptSyntax
    $checks["powershellSyntax"] = Test-PowerShellSyntax
    $checks["uiStateSelfTest"] = Test-UiStateSelfTest
    $checks["managerBridgeSelfTest"] = Test-ManagerBridgeSelfTest
    $checks["logDbGuardSelfTest"] = Test-LogDbGuardSelfTest
    $checks["upstreamProfileStorage"] = Test-UpstreamProfileStorage
    $checks["antigravityCliIsolationProfile"] = Test-AntigravityCliIsolationProfile
    $checks["antigravityCliProfilePrepare"] = Test-AntigravityCliProfilePrepare
    $checks["localConnectorVerifier"] = Test-LocalConnectorVerifier
    $checks["publicDocumentation"] = Test-PublicDocumentationContracts
    $checks["translatorRegression"] = Test-TranslatorRegression
    $checks["diffWhitespace"] = Test-GitDiffCheck
} catch {
    $line = $_.InvocationInfo.ScriptLineNumber
    $command = $_.InvocationInfo.Line
    Add-Failure "source preflight failed at line ${line}: $($_.Exception.Message) $command"
}

$elapsedMs = [int]([DateTime]::UtcNow - $startedAt).TotalMilliseconds
$antigravityCliProfilePrepareOk = $false
if ($checks["antigravityCliProfilePrepare"]) {
    $antigravityCliProfilePrepareOk = [bool]$checks["antigravityCliProfilePrepare"].ok
}
$report = [ordered]@{
    ok = ($failures.Count -eq 0)
    reportName = "source-preflight"
    noTraffic = $true
    usedRealTraffic = $false
    behaviorCovered = ($failures.Count -eq 0)
    coverageKind = "source-no-traffic"
    antigravityCliProfilePrepareOk = $antigravityCliProfilePrepareOk
    sourceRoot = Normalize-Path $SourceRoot
    startedAt = $startedAt.ToString("o")
    elapsedMs = $elapsedMs
    skipFullRegression = [bool]$SkipFullRegression
    checks = $checks
    failures = @($failures)
    warnings = @($warnings)
}
$paths = Save-JsonReport "source-preflight" $report
$report.report = [ordered]@{
    latest = $paths.latest
    history = $paths.history
}

$jsonOut = $report | ConvertTo-Json -Depth 24
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Write-Output $jsonOut
if ($failures.Count -gt 0) { exit 1 }
