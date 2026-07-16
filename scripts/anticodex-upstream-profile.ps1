#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("GetPublic", "GetRuntime", "SaveThirdParty", "UseAntigravity")]
    [string]$Action,

    [string]$StateRoot,
    [ValidateSet("", "openai-compatible", "responses")]
    [string]$Protocol = "",
    [string]$BaseUrl = "",
    [string]$Model = "",
    [string]$ApiKey = "",
    [string]$TestStatus = "pending",
    [string]$CapabilitiesJson = "{}"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Security

function Resolve-StateRoot {
    param([string]$Value)
    if ([string]::IsNullOrWhiteSpace($Value)) {
        if (-not [string]::IsNullOrWhiteSpace($env:DEEPCODEX_STATE_ROOT)) {
            $Value = $env:DEEPCODEX_STATE_ROOT
        } else {
            $Value = Join-Path $env:APPDATA "anticodex"
        }
    }
    return [System.IO.Path]::GetFullPath($Value)
}

$StateRoot = Resolve-StateRoot $StateRoot
$ProfilePath = Join-Path $StateRoot "upstream-profile.json"
$KeyPath = Join-Path $StateRoot "upstream-profile.key"
if ([string]::IsNullOrEmpty($ApiKey) -and -not [string]::IsNullOrEmpty($env:ANTICODEX_UPSTREAM_API_KEY_INPUT)) {
    $ApiKey = $env:ANTICODEX_UPSTREAM_API_KEY_INPUT
}

function New-DefaultProfile {
    [Ordered]@{
        schemaVersion = 1
        mode = "antigravity"
        protocol = ""
        baseUrl = ""
        model = ""
        lastTestStatus = ""
        lastTestAt = ""
        capabilities = @{}
    }
}

function Get-SafeProperty {
    param($Obj, [string]$Name, $Default)
    if ($null -eq $Obj) { return $Default }
    $prop = $Obj.PSObject.Properties[$Name]
    if ($null -eq $prop -or $null -eq $prop.Value) { return $Default }
    return $prop.Value
}

function Read-Profile {
    if (-not (Test-Path -LiteralPath $ProfilePath -PathType Leaf)) {
        return New-DefaultProfile
    }
    try {
        $json = Get-Content -LiteralPath $ProfilePath -Raw -Encoding UTF8
        $parsed = $json | ConvertFrom-Json
        return [Ordered]@{
            schemaVersion = [int](Get-SafeProperty $parsed "schemaVersion" 1)
            mode = [string](Get-SafeProperty $parsed "mode" "antigravity")
            protocol = [string](Get-SafeProperty $parsed "protocol" "")
            baseUrl = [string](Get-SafeProperty $parsed "baseUrl" "")
            model = [string](Get-SafeProperty $parsed "model" "")
            lastTestStatus = [string](Get-SafeProperty $parsed "lastTestStatus" "")
            lastTestAt = [string](Get-SafeProperty $parsed "lastTestAt" "")
            capabilities = Get-SafeProperty $parsed "capabilities" @{}
        }
    } catch {
        throw "Existing upstream profile is unreadable: $($_.Exception.Message)"
    }
}

function Write-Profile {
    param([hashtable]$Profile)
    New-Item -ItemType Directory -Path $StateRoot -Force | Out-Null
    $json = $Profile | ConvertTo-Json -Depth 20
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($ProfilePath, $json, $utf8NoBom)
}

function Protect-ApiKey {
    param([string]$Value)
    New-Item -ItemType Directory -Path $StateRoot -Force | Out-Null
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Value)
    $encrypted = [System.Security.Cryptography.ProtectedData]::Protect(
        $bytes,
        $null,
        [System.Security.Cryptography.DataProtectionScope]::CurrentUser
    )
    [System.IO.File]::WriteAllBytes($KeyPath, $encrypted)
}

function Unprotect-ApiKey {
    param([switch]$AllowUnreadable)
    if (-not (Test-Path -LiteralPath $KeyPath -PathType Leaf)) { return "" }
    try {
        $encrypted = [System.IO.File]::ReadAllBytes($KeyPath)
        $bytes = [System.Security.Cryptography.ProtectedData]::Unprotect(
            $encrypted,
            $null,
            [System.Security.Cryptography.DataProtectionScope]::CurrentUser
        )
        return [System.Text.Encoding]::UTF8.GetString($bytes)
    } catch {
        if ($AllowUnreadable) { return "" }
        throw "Existing upstream API key cannot be decrypted for this Windows user."
    }
}

function Get-KeyHint {
    param([string]$Value)
    if ([string]::IsNullOrEmpty($Value)) { return "" }
    if ($Value.Length -le 7) { return "***" }
    return ($Value.Substring(0, 3) + "..." + $Value.Substring($Value.Length - 4))
}

function Test-AllowedBaseUrl {
    param([string]$Value)
    try {
        $uri = [System.Uri]::new($Value)
    } catch {
        throw "BaseUrl format is invalid."
    }
    if ($uri.Scheme -eq "https") { return }
    if ($uri.Scheme -ne "http") {
        throw "BaseUrl must use https, except local loopback http."
    }
    $hostName = $uri.Host.ToLowerInvariant().Trim("[", "]")
    $allowed = @("localhost", "127.0.0.1", "::1", "0:0:0:0:0:0:0:1", "0000:0000:0000:0000:0000:0000:0000:0001")
    if ($allowed -notcontains $hostName) {
        throw "Only localhost or loopback addresses may use http."
    }
}

function Read-Capabilities {
    if ([string]::IsNullOrWhiteSpace($CapabilitiesJson)) { return @{} }
    try {
        return ($CapabilitiesJson | ConvertFrom-Json)
    } catch {
        return @{}
    }
}

function Public-Profile {
    param([hashtable]$Profile)
    $apiKey = Unprotect-ApiKey -AllowUnreadable
    [Ordered]@{
        schemaVersion = $Profile.schemaVersion
        mode = $Profile.mode
        protocol = $Profile.protocol
        baseUrl = $Profile.baseUrl
        model = $Profile.model
        lastTestStatus = $Profile.lastTestStatus
        lastTestAt = $Profile.lastTestAt
        capabilities = $Profile.capabilities
        keyConfigured = -not [string]::IsNullOrEmpty($apiKey)
        keyHint = Get-KeyHint $apiKey
    }
}

try {
    switch ($Action) {
        "GetPublic" {
            Public-Profile (Read-Profile) | ConvertTo-Json -Depth 20
        }
        "GetRuntime" {
            $profile = Read-Profile
            $runtimeApiKey = if ($profile.mode -eq "third-party") {
                Unprotect-ApiKey
            } else {
                Unprotect-ApiKey -AllowUnreadable
            }
            $runtime = [Ordered]@{
                schemaVersion = $profile.schemaVersion
                mode = $profile.mode
                protocol = $profile.protocol
                baseUrl = $profile.baseUrl
                model = $profile.model
                lastTestStatus = $profile.lastTestStatus
                lastTestAt = $profile.lastTestAt
                capabilities = $profile.capabilities
                apiKey = $runtimeApiKey
            }
            $runtime | ConvertTo-Json -Depth 20
        }
        "SaveThirdParty" {
            if ($Protocol -ne "openai-compatible" -and $Protocol -ne "responses") {
                throw "Protocol must be openai-compatible or responses."
            }
            if ([string]::IsNullOrWhiteSpace($BaseUrl)) { throw "BaseUrl is required." }
            if ([string]::IsNullOrWhiteSpace($Model)) { throw "Model is required." }
            Test-AllowedBaseUrl $BaseUrl

            $existingKey = Unprotect-ApiKey
            if ([string]::IsNullOrEmpty($ApiKey)) {
                if ([string]::IsNullOrEmpty($existingKey)) {
                    throw "ApiKey is required the first time a third-party profile is saved."
                }
            } else {
                Protect-ApiKey $ApiKey
            }

            $profile = [Ordered]@{
                schemaVersion = 1
                mode = "third-party"
                protocol = $Protocol
                baseUrl = $BaseUrl.TrimEnd("/")
                model = $Model
                lastTestStatus = $TestStatus
                lastTestAt = [DateTime]::UtcNow.ToString("o")
                capabilities = Read-Capabilities
            }
            Write-Profile $profile
            Public-Profile $profile | ConvertTo-Json -Depth 20
        }
        "UseAntigravity" {
            $profile = Read-Profile
            $profile["mode"] = "antigravity"
            Write-Profile $profile
            Public-Profile $profile | ConvertTo-Json -Depth 20
        }
    }
} catch {
    Write-Error $_.Exception.Message
    exit 1
}
