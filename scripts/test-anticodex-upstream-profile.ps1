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

function Assert-OnlyProperties {
    param($Obj, [string[]]$Expected, [string]$ContextMessage)
    $actual = @($Obj.PSObject.Properties.Name)
    foreach ($name in $Expected) {
        if ($actual -notcontains $name) { Fail-Test "$ContextMessage is missing property: $name" }
    }
    foreach ($name in $actual) {
        if ($Expected -notcontains $name) { Fail-Test "$ContextMessage contains unexpected property: $name" }
    }
}

try {
    if (-not (Test-Path -LiteralPath $ScriptPath -PathType Leaf)) {
        throw "Missing target script: $ScriptPath"
    }
    New-Item -ItemType Directory -Path $StateRoot -Force | Out-Null
    $storedFields = @("schemaVersion", "mode", "protocol", "baseUrl", "model", "contextWindow", "antigravityModel", "lastTestStatus", "lastTestAt", "capabilities")
    $publicFields = @($storedFields + @("keyConfigured", "keyHint"))
    $runtimeFields = @($storedFields + @("apiKey"))
    $historyPath = Join-Path $StateRoot "response-history.json"
    $historyMarker = '{"conversation":"keep-me","turn":42}'
    [System.IO.File]::WriteAllText($historyPath, $historyMarker, (New-Object System.Text.UTF8Encoding($false)))

    # 1. Default Public Profile check
    $public = Invoke-ProfileJson -Parameters @{ Action = "GetPublic"; StateRoot = $StateRoot }
    Assert-Equal $public.mode "antigravity" "default mode"
    Assert-Equal $public.contextWindow 272000 "default context window"
    Assert-Equal $public.antigravityModel "" "default Antigravity model"
    Assert-Equal $public.keyConfigured $false "default keyConfigured"
    Assert-Equal $public.keyHint "" "default keyHint"
    Assert-OnlyProperties $public $publicFields "default public profile"

    # 2. Test reading old upstream-profile.json containing legacy fields
    $profilePath = Join-Path $StateRoot "upstream-profile.json"
    $oldKey = [string]::Concat("antigravity", "Cli")
    $isolationKey = [string]::Concat("strict", "Windows", "AppData", "Isolation")
    $mockProfileJson = '{"schemaVersion":1,"mode":"antigravity","' + $oldKey + '":{"profileRoot":"C:\\temp","' + $isolationKey + '":true}}'
    [System.IO.File]::WriteAllText($profilePath, $mockProfileJson, (New-Object System.Text.UTF8Encoding($false)))

    $publicFromOld = Invoke-ProfileJson -Parameters @{ Action = "GetPublic"; StateRoot = $StateRoot }
    Assert-Equal $publicFromOld.mode "antigravity" "public mode from old profile"
    Assert-Equal $publicFromOld.contextWindow 272000 "old profile receives default context window"
    Assert-OnlyProperties $publicFromOld $publicFields "GetPublic from old profile"

    $runtimeFromOld = Invoke-ProfileJson -Parameters @{ Action = "GetRuntime"; StateRoot = $StateRoot }
    Assert-Equal $runtimeFromOld.mode "antigravity" "runtime mode from old profile"
    Assert-Equal $runtimeFromOld.contextWindow 272000 "old runtime profile receives default context window"
    Assert-OnlyProperties $runtimeFromOld $runtimeFields "GetRuntime from old profile"

    $corruptStateRoot = Join-Path $StateRoot "corrupt-profile"
    New-Item -ItemType Directory -Path $corruptStateRoot -Force | Out-Null
    [System.IO.File]::WriteAllText(
        (Join-Path $corruptStateRoot "upstream-profile.json"),
        '{"mode":"third-party",',
        (New-Object System.Text.UTF8Encoding($false))
    )
    if (-not (Test-ProfileFails @{ Action = "GetRuntime"; StateRoot = $corruptStateRoot })) {
        Fail-Test "corrupt existing third-party profile must fail closed"
    }

    # Write-back test: saving third-party should not persist legacy fields
    $saved = Invoke-ProfileJson -Parameters @{
        Action = "SaveThirdParty"
        StateRoot = $StateRoot
        Protocol = "openai-compatible"
        BaseUrl = "https://api.custom.example/v1/"
        Model = "custom-gpt"
        ContextWindow = 128000
        ApiKey = "sk-proj-mysecretkey1234"
        TestStatus = "success"
        CapabilitiesJson = '{"stream":true,"toolCalls":true}'
    }
    Assert-Equal $saved.mode "third-party" "saved mode"
    Assert-Equal $saved.protocol "openai-compatible" "saved protocol"
    Assert-Equal $saved.baseUrl "https://api.custom.example/v1" "saved baseUrl trims slash"
    Assert-Equal $saved.model "custom-gpt" "saved model"
    Assert-Equal $saved.contextWindow 128000 "saved context window"
    Assert-Equal $saved.antigravityModel "" "third-party save preserves default Antigravity model"
    Assert-Equal $saved.lastTestStatus "success" "saved lastTestStatus"
    Assert-Equal $saved.keyConfigured $true "saved keyConfigured"
    Assert-Equal $saved.keyHint "sk-...1234" "saved keyHint"
    Assert-OnlyProperties $saved $publicFields "SaveThirdParty output"

    $keyPath = Join-Path $StateRoot "upstream-profile.key"
    if (-not (Test-Path -LiteralPath $profilePath -PathType Leaf)) { Fail-Test "profile json was not written" }
    if (-not (Test-Path -LiteralPath $keyPath -PathType Leaf)) { Fail-Test "encrypted key was not written" }

    $jsonText = Get-Content -LiteralPath $profilePath -Raw
    $storedProfile = $jsonText | ConvertFrom-Json
    Assert-OnlyProperties $storedProfile $storedFields "saved profile json on disk"
    Assert-Equal $storedProfile.contextWindow 128000 "stored context window"
    if ($jsonText -match "sk-proj-mysecretkey1234") { Fail-Test "plain API key leaked to profile json" }

    $publicTextAfterSave = Invoke-Profile -Parameters @{ Action = "GetPublic"; StateRoot = $StateRoot }
    if ($publicTextAfterSave -match "sk-proj-mysecretkey1234") {
        Fail-Test "plain API key leaked from GetPublic"
    }

    $runtime = Invoke-ProfileJson -Parameters @{ Action = "GetRuntime"; StateRoot = $StateRoot }
    Assert-Equal $runtime.mode "third-party" "runtime mode"
    Assert-Equal $runtime.apiKey "sk-proj-mysecretkey1234" "runtime apiKey"
    Assert-Equal $runtime.contextWindow 128000 "runtime context window"
    Assert-OnlyProperties $runtime $runtimeFields "runtime profile after SaveThirdParty"

    # DPAPI corrupt / fail closed tests
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
    Assert-OnlyProperties $recoveredToAntigravity $publicFields "recovered to Antigravity public profile"

    # Restore valid key
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
        Protocol = "responses"
        BaseUrl = "https://api.responses.example/v1"
        Model = "responses-model"
        ApiKey = ""
        TestStatus = "pending"
    }
    Assert-Equal $savedAgain.protocol "responses" "empty key save updates protocol"
    $runtimeAgain = Invoke-ProfileJson -Parameters @{ Action = "GetRuntime"; StateRoot = $StateRoot }
    Assert-Equal $runtimeAgain.apiKey "sk-proj-mysecretkey1234" "empty key save keeps old key"

    if (-not (Test-ProfileFails @{
        Action = "SaveThirdParty"
        StateRoot = $StateRoot
        Protocol = "anthropic"
        BaseUrl = "https://api.anthropic.com"
        Model = "claude-3-5-sonnet"
        ApiKey = "sk-test"
        TestStatus = "pending"
    })) { Fail-Test "Anthropic protocol must be rejected" }

    foreach ($badContextWindow in @(15999, 4000001)) {
        if (-not (Test-ProfileFails @{
            Action = "SaveThirdParty"
            StateRoot = $StateRoot
            Protocol = "openai-compatible"
            BaseUrl = "https://api.context.example/v1"
            Model = "context-model"
            ContextWindow = $badContextWindow
            ApiKey = "sk-test"
            TestStatus = "success"
        })) { Fail-Test "invalid context window should fail: $badContextWindow" }
    }

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

    $back = Invoke-ProfileJson -Parameters @{ Action = "UseAntigravity"; StateRoot = $StateRoot; AntigravityModel = "claude-sonnet-4-6" }
    Assert-Equal $back.mode "antigravity" "UseAntigravity mode"
    Assert-Equal $back.antigravityModel "claude-sonnet-4-6" "UseAntigravity persists selected model"
    Assert-Equal $back.protocol "openai-compatible" "UseAntigravity preserves protocol"
    Assert-Equal $back.baseUrl "http://[::1]:8080" "UseAntigravity preserves baseUrl"
    Assert-Equal $back.model "m" "UseAntigravity preserves model"
    Assert-Equal $back.keyConfigured $true "UseAntigravity preserves key state"
    Assert-OnlyProperties $back $publicFields "UseAntigravity profile preserves third-party info"

    $runtimeBack = Invoke-ProfileJson -Parameters @{ Action = "GetRuntime"; StateRoot = $StateRoot }
    Assert-Equal $runtimeBack.antigravityModel "claude-sonnet-4-6" "runtime exposes selected Antigravity model"

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
