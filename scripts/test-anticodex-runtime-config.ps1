[CmdletBinding()]
param(
    [string]$StateRoot = $(Join-Path $env:APPDATA "anticodex")
)

$ErrorActionPreference = "Stop"
$failures = New-Object System.Collections.Generic.List[string]

function Add-Failure {
    param([string]$Message)
    $failures.Add($Message) | Out-Null
}

function Normalize-Path {
    param([string]$Path)
    return [IO.Path]::GetFullPath($Path)
}

function Get-TomlScalar {
    param([string]$Text, [string]$Key)
    $pattern = "(?m)^\s*$([regex]::Escape($Key))\s*=\s*(.+?)\s*$"
    $match = [regex]::Match($Text, $pattern)
    if (-not $match.Success) { return $null }
    return $match.Groups[1].Value.Trim()
}

function Get-FeatureFlag {
    param([string]$Text, [string]$Key)
    $features = [regex]::Match($Text, '(?ms)^\s*\[features\]\s*$([\s\S]*?)(?=^\s*\[[^\]]+\]\s*$|\z)')
    if (-not $features.Success) { return $null }
    return Get-TomlScalar -Text $features.Groups[1].Value -Key $Key
}

function ConvertTo-TomlString {
    param([string]$Value)
    return "`"$($Value.Replace('\', '\\').Replace('"', '\"'))`""
}

function Expect-TomlString {
    param([string]$Text, [string]$Key, [string]$Expected)
    $actual = Get-TomlScalar $Text $Key
    if ($null -eq $actual) {
        Add-Failure "config missing $Key"
        return
    }
    $expectedToml = ConvertTo-TomlString $Expected
    if ($actual -ne $expectedToml) {
        Add-Failure "config $Key is $actual, expected $expectedToml"
    }
}

function Expect-FeatureFalse {
    param([string]$Text, [string]$Key)
    $actual = Get-FeatureFlag $Text $Key
    if ($null -eq $actual) {
        Add-Failure "config missing [features].$Key"
        return
    }
    if ($actual -ne "false") {
        Add-Failure "config [features].$Key is $actual, expected false"
    }
}

$stateRootFull = Normalize-Path $StateRoot
$expectedStateRoot = Normalize-Path (Join-Path $env:APPDATA "anticodex")
if ($stateRootFull -ne $expectedStateRoot) {
    Add-Failure "runtime config check may only inspect $expectedStateRoot"
}

$codexHome = Normalize-Path (Join-Path $stateRootFull "codex-home-deepseek-app")
$sharedCodexHome = Normalize-Path (Join-Path $env:USERPROFILE ".codex")
$configPath = Join-Path $codexHome "config.toml"
$modelCatalogPath = Join-Path $codexHome "deepseek-model-catalog.json"
$text = ""

try {
    if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
        Add-Failure "Anti-Codex runtime config is missing: $configPath"
    } else {
        $text = Get-Content -LiteralPath $configPath -Raw
    }
    if (-not (Test-Path -LiteralPath $modelCatalogPath -PathType Leaf)) {
        Add-Failure "Anti-Codex model catalog is missing: $modelCatalogPath"
    }
} catch {
    Add-Failure "runtime config read failed: $($_.Exception.Message)"
}

if ($text) {
    if ($codexHome -eq $sharedCodexHome) {
        Add-Failure "Anti-Codex codex home is not isolated from the original Codex home"
    }

    Expect-TomlString $text "cli_auth_credentials_store" "file"
    Expect-TomlString $text "model_catalog_json" $modelCatalogPath

    $openaiBaseUrl = Get-TomlScalar $text "openai_base_url"
    $chatgptBaseUrl = Get-TomlScalar $text "chatgpt_base_url"
    if ($null -eq $openaiBaseUrl) {
        Add-Failure "config missing openai_base_url"
    } elseif ($openaiBaseUrl -notmatch '^"http://(127\.0\.0\.1|localhost|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)') {
        Add-Failure "openai_base_url is not a local Anti-Codex gateway: $openaiBaseUrl"
    }
    if ($null -eq $chatgptBaseUrl) {
        Add-Failure "config missing chatgpt_base_url"
    } elseif ($chatgptBaseUrl -notmatch '^"http://(127\.0\.0\.1|localhost|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.).*/backend-api/?') {
        Add-Failure "chatgpt_base_url is not the local Anti-Codex backend API: $chatgptBaseUrl"
    }

    foreach ($flag in @(
        "responses_websockets",
        "responses_websockets_v2",
        "plugins",
        "plugin_sharing",
        "remote_plugin"
    )) {
        Expect-FeatureFalse $text $flag
    }

    if ($text -match "(?i)chatgpt\.com|auth/login|api\.openai\.com") {
        Add-Failure "runtime config contains a remote ChatGPT/OpenAI account endpoint"
    }
}

$result = [pscustomobject]@{
    ok = ($failures.Count -eq 0)
    failures = $failures.ToArray()
    stateRoot = $stateRootFull
    codexHome = $codexHome
    sharedCodexHome = $sharedCodexHome
    configPath = $configPath
    modelCatalogPath = $modelCatalogPath
    features = if ($text) {
        [pscustomobject]@{
            responses_websockets = Get-FeatureFlag $text "responses_websockets"
            responses_websockets_v2 = Get-FeatureFlag $text "responses_websockets_v2"
            plugins = Get-FeatureFlag $text "plugins"
            plugin_sharing = Get-FeatureFlag $text "plugin_sharing"
            remote_plugin = Get-FeatureFlag $text "remote_plugin"
        }
    } else { $null }
}

$result | ConvertTo-Json -Depth 8 -Compress
if ($failures.Count -gt 0) { exit 1 }
