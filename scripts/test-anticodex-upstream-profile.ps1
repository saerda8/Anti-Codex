#Requires -Version 5.1
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ScriptPath = Join-Path $PSScriptRoot "anticodex-upstream-profile.ps1"
$StateRoot = Join-Path $env:TEMP ("anticodex-upstream-profile-test-" + [Guid]::NewGuid().ToString("N"))
$failed = $false
$global:LASTEXITCODE = 0

function Fail-Test {
    param([string]$Message)
    Write-Host ("FAIL: " + $Message) -ForegroundColor Red
    $script:failed = $true
}

function Assert-Equal {
    param($Actual, $Expected, [string]$Message)
    if ($Actual -ne $Expected) {
        Fail-Test "$Message. Actual=[$Actual], Expected=[$Expected]"
    }
}

function Invoke-Profile {
    param([hashtable]$Parameters)
    $output = & $ScriptPath @Parameters
    return ($output -join [Environment]::NewLine)
}

function Invoke-ProfileJson {
    param([hashtable]$Parameters)
    return (Invoke-Profile -Parameters $Parameters | ConvertFrom-Json)
}

function Test-ProfileFails {
    param([hashtable]$Parameters)
    try {
        $null = & $ScriptPath @Parameters 2>$null
        return $false
    } catch {
        return $true
    }
}

try {
    if (-not (Test-Path -LiteralPath $ScriptPath -PathType Leaf)) {
        throw "Missing target script: $ScriptPath"
    }
    New-Item -ItemType Directory -Path $StateRoot -Force | Out-Null
    $historyPath = Join-Path $StateRoot "response-history.json"
    $historyMarker = '{"conversation":"keep-me","turn":42}'
    [System.IO.File]::WriteAllText($historyPath, $historyMarker, (New-Object System.Text.UTF8Encoding($false)))

    $public = Invoke-ProfileJson -Parameters @{ Action = "GetPublic"; StateRoot = $StateRoot }
    Assert-Equal $public.mode "antigravity" "default mode"
    Assert-Equal $public.keyConfigured $false "default keyConfigured"
    Assert-Equal $public.keyHint "" "default keyHint"
    Assert-Equal $public.antigravityCli.profileRoot "" "default Antigravity CLI profileRoot"
    Assert-Equal $public.antigravityCli.strictWindowsAppDataIsolation $false "default Antigravity CLI strict AppData isolation"

    $savedAntigravityCli = Invoke-ProfileJson -Parameters @{
        Action = "SaveAntigravity"
        StateRoot = $StateRoot
        AntigravityCliProfileRoot = (Join-Path $StateRoot "ag-account-b")
        AntigravityCliStrictWindowsAppDataIsolation = "true"
    }
    Assert-Equal $savedAntigravityCli.mode "antigravity" "SaveAntigravity mode"
    Assert-Equal $savedAntigravityCli.antigravityCli.profileRoot (Join-Path $StateRoot "ag-account-b") "SaveAntigravity profileRoot"
    Assert-Equal $savedAntigravityCli.antigravityCli.strictWindowsAppDataIsolation $true "SaveAntigravity strict isolation"

    $runtimeAntigravityCli = Invoke-ProfileJson -Parameters @{ Action = "GetRuntime"; StateRoot = $StateRoot }
    Assert-Equal $runtimeAntigravityCli.antigravityCli.profileRoot (Join-Path $StateRoot "ag-account-b") "runtime Antigravity CLI profileRoot"
    Assert-Equal $runtimeAntigravityCli.antigravityCli.strictWindowsAppDataIsolation $true "runtime Antigravity CLI strict isolation"

    $corruptStateRoot = Join-Path $StateRoot "corrupt-profile"
    New-Item -ItemType Directory -Path $corruptStateRoot -Force | Out-Null
    [System.IO.File]::WriteAllText(
        (Join-Path $corruptStateRoot "upstream-profile.json"),
        '{"mode":"third-party",',
        (New-Object System.Text.UTF8Encoding($false))
    )
    if (-not (Test-ProfileFails @{
        Action = "GetRuntime"
        StateRoot = $corruptStateRoot
    })) { Fail-Test "corrupt existing third-party profile must fail closed" }

    $saved = Invoke-ProfileJson -Parameters @{
        Action = "SaveThirdParty"
        StateRoot = $StateRoot
        Protocol = "openai-compatible"
        BaseUrl = "https://api.custom.example/v1/"
        Model = "custom-gpt"
        ApiKey = "sk-proj-mysecretkey1234"
        TestStatus = "success"
        CapabilitiesJson = '{"stream":true,"toolCalls":true}'
    }
    Assert-Equal $saved.mode "third-party" "saved mode"
    Assert-Equal $saved.protocol "openai-compatible" "saved protocol"
    Assert-Equal $saved.baseUrl "https://api.custom.example/v1" "saved baseUrl trims slash"
    Assert-Equal $saved.model "custom-gpt" "saved model"
    Assert-Equal $saved.lastTestStatus "success" "saved lastTestStatus"
    Assert-Equal $saved.keyConfigured $true "saved keyConfigured"
    Assert-Equal $saved.keyHint "sk-...1234" "saved keyHint"
    Assert-Equal $saved.antigravityCli.profileRoot (Join-Path $StateRoot "ag-account-b") "SaveThirdParty preserves Antigravity CLI profileRoot"
    Assert-Equal $saved.antigravityCli.strictWindowsAppDataIsolation $true "SaveThirdParty preserves Antigravity CLI strict isolation"

    $profilePath = Join-Path $StateRoot "upstream-profile.json"
    $keyPath = Join-Path $StateRoot "upstream-profile.key"
    if (-not (Test-Path -LiteralPath $profilePath -PathType Leaf)) { Fail-Test "profile json was not written" }
    if (-not (Test-Path -LiteralPath $keyPath -PathType Leaf)) { Fail-Test "encrypted key was not written" }

    $jsonText = Get-Content -LiteralPath $profilePath -Raw
    if ($jsonText -match "sk-proj-mysecretkey1234") { Fail-Test "plain API key leaked to profile json" }
    if ((Invoke-Profile -Parameters @{ Action = "GetPublic"; StateRoot = $StateRoot }) -match "sk-proj-mysecretkey1234") {
        Fail-Test "plain API key leaked from GetPublic"
    }

    $runtime = Invoke-ProfileJson -Parameters @{ Action = "GetRuntime"; StateRoot = $StateRoot }
    Assert-Equal $runtime.mode "third-party" "runtime mode"
    Assert-Equal $runtime.apiKey "sk-proj-mysecretkey1234" "runtime apiKey"

    $encryptedKey = [System.IO.File]::ReadAllBytes($keyPath)
    [System.IO.File]::WriteAllBytes($keyPath, [byte[]](1, 2, 3, 4))
    if (-not (Test-ProfileFails @{
        Action = "GetRuntime"
        StateRoot = $StateRoot
    })) { Fail-Test "unreadable existing third-party key must fail closed" }
    $recoveredToAntigravity = Invoke-ProfileJson -Parameters @{
        Action = "UseAntigravity"
        StateRoot = $StateRoot
    }
    Assert-Equal $recoveredToAntigravity.mode "antigravity" "corrupt third-party key can still restore Antigravity"
    [System.IO.File]::WriteAllBytes($keyPath, $encryptedKey)
    $null = Invoke-ProfileJson -Parameters @{
        Action = "SaveThirdParty"
        StateRoot = $StateRoot
        Protocol = "openai-compatible"
        BaseUrl = "https://api.custom.example/v1"
        Model = "custom-gpt"
        ApiKey = ""
        TestStatus = "success"
    }

    $savedAgain = Invoke-ProfileJson -Parameters @{
        Action = "SaveThirdParty"
        StateRoot = $StateRoot
        Protocol = "anthropic"
        BaseUrl = "https://api.anthropic.com"
        Model = "claude-3-5-sonnet"
        ApiKey = ""
        TestStatus = "pending"
    }
    Assert-Equal $savedAgain.protocol "anthropic" "empty key save updates protocol"
    $runtimeAgain = Invoke-ProfileJson -Parameters @{ Action = "GetRuntime"; StateRoot = $StateRoot }
    Assert-Equal $runtimeAgain.apiKey "sk-proj-mysecretkey1234" "empty key save keeps old key"

    $emptyStateRoot = Join-Path $StateRoot "empty"
    if (-not (Test-ProfileFails @{
        Action = "SaveThirdParty"
        StateRoot = $emptyStateRoot
        Protocol = "openai-compatible"
        BaseUrl = "https://api.empty.example/v1"
        Model = "m"
        ApiKey = ""
        TestStatus = "success"
    })) { Fail-Test "first save without api key should fail" }

    foreach ($badUrl in @("http://google.com/v1", "http://127.0.0.2/v1", "ftp://localhost/v1", "http://localhost.company.com/v1")) {
        if (-not (Test-ProfileFails @{
            Action = "SaveThirdParty"
            StateRoot = $StateRoot
            Protocol = "openai-compatible"
            BaseUrl = $badUrl
            Model = "m"
            ApiKey = "sk-test"
            TestStatus = "success"
        })) { Fail-Test "invalid URL should fail: $badUrl" }
    }

    foreach ($goodUrl in @("https://api.example.com/v1", "http://localhost:8080/v1", "http://127.0.0.1:3000", "http://[::1]:8080")) {
        $result = Invoke-ProfileJson -Parameters @{
            Action = "SaveThirdParty"
            StateRoot = $StateRoot
            Protocol = "openai-compatible"
            BaseUrl = $goodUrl
            Model = "m"
            ApiKey = "sk-test"
            TestStatus = "success"
        }
        Assert-Equal $result.baseUrl $goodUrl "valid URL should save"
    }

    $back = Invoke-ProfileJson -Parameters @{ Action = "UseAntigravity"; StateRoot = $StateRoot }
    Assert-Equal $back.mode "antigravity" "UseAntigravity mode"
    Assert-Equal $back.protocol "openai-compatible" "UseAntigravity preserves protocol"
    Assert-Equal $back.baseUrl "http://[::1]:8080" "UseAntigravity preserves baseUrl"
    Assert-Equal $back.model "m" "UseAntigravity preserves model"
    Assert-Equal $back.keyConfigured $true "UseAntigravity preserves key state"
    Assert-Equal $back.antigravityCli.profileRoot (Join-Path $StateRoot "ag-account-b") "UseAntigravity preserves Antigravity CLI profileRoot"
    Assert-Equal $back.antigravityCli.strictWindowsAppDataIsolation $true "UseAntigravity preserves Antigravity CLI strict isolation"
    Assert-Equal (Get-Content -LiteralPath $historyPath -Raw) $historyMarker "provider switching preserves response history"

    $bytes = [System.IO.File]::ReadAllBytes($profilePath)
    if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
        Fail-Test "profile json has UTF-8 BOM"
    }

    $realProfilePath = Join-Path $env:APPDATA "anticodex\upstream-profile.json"
    if ((Test-Path -LiteralPath $realProfilePath -PathType Leaf) -and ((Get-Date) - (Get-Item -LiteralPath $realProfilePath).LastWriteTime -lt [TimeSpan]::FromSeconds(15))) {
        Fail-Test "test touched real APPDATA profile"
    }
} catch {
    Fail-Test $_.Exception.Message
} finally {
    Remove-Item -LiteralPath $StateRoot -Recurse -Force -ErrorAction SilentlyContinue
}

if ($failed) {
    exit 1
}

Write-Host "Anti-Codex upstream profile storage tests passed."
exit 0
