#Requires -Version 5.1

param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("HasCredential", "Capture", "Restore", "HasDesktop", "PauseDesktop", "ResumeDesktop")]
    [string]$Action
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
[Console]::InputEncoding = New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)

$TargetName = "gemini:antigravity"
$EntropyText = "anticodex-antigravity-accounts-v1"

function Read-JsonInput {
    $text = [Console]::In.ReadToEnd()
    if ([string]::IsNullOrWhiteSpace($text)) { return [pscustomobject]@{} }
    try { return $text | ConvertFrom-Json } catch { throw "Invalid helper input." }
}

function Write-JsonResult([object]$Value) {
    [Console]::Out.Write(($Value | ConvertTo-Json -Compress -Depth 12))
}

function Clear-Bytes([byte[]]$Value) {
    if ($null -ne $Value) { [Array]::Clear($Value, 0, $Value.Length) }
}

function Assert-OfficialCredentialJson([byte[]]$Blob) {
    if ($null -eq $Blob -or $Blob.Length -eq 0 -or $Blob.Length -gt 1048576) {
        throw "Invalid Antigravity credential data."
    }
    try {
        $value = [Text.Encoding]::UTF8.GetString($Blob) | ConvertFrom-Json
    } catch {
        throw "Invalid Antigravity credential data."
    }
    $top = @($value.PSObject.Properties.Name)
    $token = $value.token
    $tokenFields = if ($null -ne $token) { @($token.PSObject.Properties.Name) } else { @() }
    if ($top.Count -ne 2 -or $top -notcontains "token" -or $top -notcontains "auth_method" -or
        $tokenFields.Count -ne 4 -or $tokenFields -notcontains "access_token" -or
        $tokenFields -notcontains "token_type" -or $tokenFields -notcontains "refresh_token" -or
        $tokenFields -notcontains "expiry" -or [string]::IsNullOrWhiteSpace([string]$token.access_token) -or
        [string]::IsNullOrWhiteSpace([string]$token.token_type) -or
        [string]::IsNullOrWhiteSpace([string]$token.refresh_token) -or
        [string]::IsNullOrWhiteSpace([string]$token.expiry) -or
        [string]::IsNullOrWhiteSpace([string]$value.auth_method)) {
        throw "Invalid Antigravity credential data."
    }
    return $value
}

function Ensure-NativeCredentialApi {
    if (-not ("AntiCodex.Antigravity.CredentialNative" -as [type])) {
        Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

namespace AntiCodex.Antigravity {
    [StructLayout(LayoutKind.Sequential)]
    public struct NativeCredential {
        public UInt32 Flags;
        public UInt32 Type;
        public IntPtr TargetName;
        public IntPtr Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public UInt32 CredentialBlobSize;
        public IntPtr CredentialBlob;
        public UInt32 Persist;
        public UInt32 AttributeCount;
        public IntPtr Attributes;
        public IntPtr TargetAlias;
        public IntPtr UserName;
    }

    public static class CredentialNative {
        [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern bool CredReadW(string target, UInt32 type, UInt32 flags, out IntPtr credential);

        [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern bool CredWriteW(ref NativeCredential credential, UInt32 flags);

        [DllImport("advapi32.dll", EntryPoint = "CredFree")]
        public static extern void CredFree(IntPtr credential);
    }
}
"@
    }
    Add-Type -AssemblyName System.Security
}

function Read-ExactCredential {
    Ensure-NativeCredentialApi
    $pointer = [IntPtr]::Zero
    if (-not [AntiCodex.Antigravity.CredentialNative]::CredReadW($TargetName, 1, 0, [ref]$pointer)) {
        throw "Antigravity credential is unavailable."
    }
    try {
        $credential = [Runtime.InteropServices.Marshal]::PtrToStructure(
            $pointer,
            [type][AntiCodex.Antigravity.NativeCredential]
        )
        if ($credential.CredentialBlobSize -le 0 -or $credential.CredentialBlobSize -gt 1048576) {
            throw "Invalid Antigravity credential data."
        }
        $blob = New-Object byte[] ([int]$credential.CredentialBlobSize)
        [Runtime.InteropServices.Marshal]::Copy($credential.CredentialBlob, $blob, 0, $blob.Length)
        return [pscustomobject]@{
            Blob = $blob
            Persist = [uint32]$credential.Persist
            UserName = if ($credential.UserName -ne [IntPtr]::Zero) {
                [Runtime.InteropServices.Marshal]::PtrToStringUni($credential.UserName)
            } else { "" }
        }
    } finally {
        if ($pointer -ne [IntPtr]::Zero) {
            [AntiCodex.Antigravity.CredentialNative]::CredFree($pointer)
        }
    }
}

function Invoke-HasCredential {
    Ensure-NativeCredentialApi
    $pointer = [IntPtr]::Zero
    $exists = [AntiCodex.Antigravity.CredentialNative]::CredReadW($TargetName, 1, 0, [ref]$pointer)
    if (-not $exists -and [Runtime.InteropServices.Marshal]::GetLastWin32Error() -ne 1168) {
        throw "Antigravity credential status is unavailable."
    }
    try { Write-JsonResult ([pscustomobject]@{ exists = [bool]$exists }) }
    finally { if ($pointer -ne [IntPtr]::Zero) { [AntiCodex.Antigravity.CredentialNative]::CredFree($pointer) } }
}

function Get-ExistingCredentialMetadata {
    Ensure-NativeCredentialApi
    $pointer = [IntPtr]::Zero
    if (-not [AntiCodex.Antigravity.CredentialNative]::CredReadW($TargetName, 1, 0, [ref]$pointer)) {
        if ([Runtime.InteropServices.Marshal]::GetLastWin32Error() -eq 1168) {
            return [pscustomobject]@{ Persist = [uint32]2; UserName = "antigravity" }
        }
        throw "Antigravity credential metadata is unavailable."
    }
    try {
        $credential = [Runtime.InteropServices.Marshal]::PtrToStructure(
            $pointer,
            [type][AntiCodex.Antigravity.NativeCredential]
        )
        return [pscustomobject]@{
            Persist = if ($credential.Persist -gt 0) { [uint32]$credential.Persist } else { [uint32]2 }
            UserName = if ($credential.UserName -ne [IntPtr]::Zero) {
                [Runtime.InteropServices.Marshal]::PtrToStringUni($credential.UserName)
            } else { "antigravity" }
        }
    } finally {
        if ($pointer -ne [IntPtr]::Zero) {
            [AntiCodex.Antigravity.CredentialNative]::CredFree($pointer)
        }
    }
}

function Write-ExactCredential([byte[]]$Blob) {
    Ensure-NativeCredentialApi
    Assert-OfficialCredentialJson $Blob | Out-Null
    $metadata = Get-ExistingCredentialMetadata
    $targetPointer = [IntPtr]::Zero
    $userPointer = [IntPtr]::Zero
    $blobPointer = [IntPtr]::Zero
    try {
        $targetPointer = [Runtime.InteropServices.Marshal]::StringToCoTaskMemUni($TargetName)
        $userPointer = [Runtime.InteropServices.Marshal]::StringToCoTaskMemUni([string]$metadata.UserName)
        $blobPointer = [Runtime.InteropServices.Marshal]::AllocCoTaskMem($Blob.Length)
        [Runtime.InteropServices.Marshal]::Copy($Blob, 0, $blobPointer, $Blob.Length)
        $credential = New-Object AntiCodex.Antigravity.NativeCredential
        $credential.Type = 1
        $credential.TargetName = $targetPointer
        $credential.CredentialBlobSize = [uint32]$Blob.Length
        $credential.CredentialBlob = $blobPointer
        $credential.Persist = [uint32]$metadata.Persist
        $credential.UserName = $userPointer
        if (-not [AntiCodex.Antigravity.CredentialNative]::CredWriteW([ref]$credential, 0)) {
            throw "Antigravity credential restore failed."
        }
    } finally {
        if ($blobPointer -ne [IntPtr]::Zero) {
            for ($index = 0; $index -lt $Blob.Length; $index++) {
                [Runtime.InteropServices.Marshal]::WriteByte($blobPointer, $index, 0)
            }
            [Runtime.InteropServices.Marshal]::FreeCoTaskMem($blobPointer)
        }
        if ($userPointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::FreeCoTaskMem($userPointer) }
        if ($targetPointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::FreeCoTaskMem($targetPointer) }
    }
}

function Get-MaskedEmail([string]$Email) {
    $parts = $Email.Split('@', 2)
    if ($parts.Count -ne 2 -or [string]::IsNullOrWhiteSpace($parts[0]) -or [string]::IsNullOrWhiteSpace($parts[1])) {
        throw "Antigravity account identity lookup failed."
    }
    $shown = [Math]::Min(2, [Math]::Max(0, $parts[0].Length - 1))
    return $parts[0].Substring(0, $shown) + ('*' * [Math]::Max(3, $parts[0].Length - $shown)) + '@' + $parts[1]
}

function Get-Sha256Hex([byte[]]$Bytes) {
    $hasher = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($hasher.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant() }
    finally { $hasher.Dispose() }
}

function Invoke-Capture {
    $credential = $null
    [byte[]]$blob = $null
    [byte[]]$entropy = $null
    [byte[]]$encrypted = $null
    [byte[]]$emailBytes = $null
    $authorization = $null
    try {
        $credential = Read-ExactCredential
        $blob = $credential.Blob
        $value = Assert-OfficialCredentialJson $blob
        $authorization = "Bearer " + [string]$value.token.access_token
        try {
            $identity = Invoke-RestMethod -Method Get `
                -Uri "https://openidconnect.googleapis.com/v1/userinfo" `
                -Headers @{ Authorization = $authorization } `
                -TimeoutSec 30
        } catch {
            throw "Antigravity account identity lookup failed."
        }
        $email = ([string]$identity.email).Trim().ToLowerInvariant()
        if ([string]::IsNullOrWhiteSpace($email)) { throw "Antigravity account identity lookup failed." }
        $entropy = [Text.Encoding]::UTF8.GetBytes($EntropyText)
        $encrypted = [Security.Cryptography.ProtectedData]::Protect(
            $blob,
            $entropy,
            [Security.Cryptography.DataProtectionScope]::CurrentUser
        )
        $emailBytes = [Text.Encoding]::UTF8.GetBytes($email)
        Write-JsonResult ([pscustomobject]@{
            id = "sha256:" + (Get-Sha256Hex $emailBytes)
            maskedEmail = Get-MaskedEmail $email
            sealed = "dpapi:v1:" + [Convert]::ToBase64String($encrypted)
            credentialHash = Get-Sha256Hex $blob
        })
    } finally {
        $authorization = $null
        Clear-Bytes $emailBytes
        Clear-Bytes $encrypted
        Clear-Bytes $entropy
        Clear-Bytes $blob
        if ($null -ne $credential) { $credential.Blob = $null }
    }
}

function Invoke-Restore([object]$InputValue) {
    [byte[]]$encrypted = $null
    [byte[]]$entropy = $null
    [byte[]]$blob = $null
    try {
        Ensure-NativeCredentialApi
        $sealed = [string]$InputValue.sealed
        if (-not $sealed.StartsWith("dpapi:v1:", [StringComparison]::Ordinal)) {
            throw "Invalid sealed Antigravity credential."
        }
        try { $encrypted = [Convert]::FromBase64String($sealed.Substring(9)) }
        catch { throw "Invalid sealed Antigravity credential." }
        $entropy = [Text.Encoding]::UTF8.GetBytes($EntropyText)
        try {
            $blob = [Security.Cryptography.ProtectedData]::Unprotect(
                $encrypted,
                $entropy,
                [Security.Cryptography.DataProtectionScope]::CurrentUser
            )
        } catch {
            throw "Invalid sealed Antigravity credential."
        }
        Assert-OfficialCredentialJson $blob | Out-Null
        Write-ExactCredential $blob
        Write-JsonResult ([pscustomobject]@{ ok = $true })
    } finally {
        Clear-Bytes $blob
        Clear-Bytes $entropy
        Clear-Bytes $encrypted
    }
}

function Assert-NoConflictingAntigravityProcess {
    if (Get-Process -Name "agy" -ErrorAction SilentlyContinue) {
        throw "Antigravity CLI is running; account change was refused."
    }
    if (Get-Process -Name "Antigravity IDE" -ErrorAction SilentlyContinue) {
        throw "Legacy Antigravity IDE is running; account change was refused."
    }
}

function Resolve-OfficialDesktop {
    $path = Resolve-AntigravityDesktopPath
    if (-not $path -or [IO.Path]::GetFileName($path) -ine "Antigravity.exe" -or -not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Official Antigravity Desktop could not be resolved safely."
    }
    return [IO.Path]::GetFullPath($path)
}

function Invoke-HasDesktop {
    $path = Resolve-OfficialDesktop
    $existing = Get-AntigravityMainProcess -ExecutablePath $path
    if (-not $existing -and (Get-Process -Name "Antigravity" -ErrorAction SilentlyContinue)) {
        throw "A running Antigravity process could not be identified safely."
    }
    Write-JsonResult ([pscustomobject]@{ running = [bool]$existing })
}

function Invoke-PauseDesktop([object]$InputValue) {
    if ($InputValue.acknowledgeRestart -ne $true) { throw "Antigravity restart acknowledgement is required." }
    Assert-NoConflictingAntigravityProcess
    $path = Resolve-OfficialDesktop
    $existing = Get-AntigravityMainProcess -ExecutablePath $path
    if (-not $existing) {
        if (Get-Process -Name "Antigravity" -ErrorAction SilentlyContinue) {
            throw "A running Antigravity process could not be identified safely."
        }
        Write-JsonResult ([pscustomobject]@{ wasRunning = $false })
        return
    }
    $pidValue = [int]$existing.ProcessId
    $started = ([DateTime]$existing.CreationDate).Ticks
    $process = Get-Process -Id $pidValue -ErrorAction Stop
    if ([IO.Path]::GetFullPath([string]$process.Path) -ine $path -or $process.StartTime.Ticks -ne $started) {
        throw "Antigravity Desktop process identity changed; account change was refused."
    }
    $taskkill = Join-Path $env:SystemRoot "System32\taskkill.exe"
    & $taskkill /PID $pidValue /T /F | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Antigravity Desktop could not be paused." }
    try { Wait-Process -Id $pidValue -Timeout 15 -ErrorAction Stop } catch {}
    if (Get-Process -Id $pidValue -ErrorAction SilentlyContinue) { throw "Antigravity Desktop did not stop." }
    Write-JsonResult ([pscustomobject]@{ wasRunning = $true })
}

function Invoke-ResumeDesktop([object]$InputValue) {
    $properties = @($InputValue.PSObject.Properties.Name)
    if ($properties.Count -ne 1 -or $properties[0] -ne "wasRunning" -or $InputValue.wasRunning -isnot [bool]) {
        throw "Invalid Antigravity resume context."
    }
    if (-not $InputValue.wasRunning) {
        Write-JsonResult ([pscustomobject]@{ ok = $true; launched = $false })
        return
    }
    Assert-NoConflictingAntigravityProcess
    $path = Resolve-OfficialDesktop
    if (Get-AntigravityMainProcess -ExecutablePath $path) {
        throw "Antigravity Desktop is already running; resume was refused."
    }
    Start-Process -FilePath $path -WindowStyle Hidden -PassThru | Out-Null
    $stable = Wait-AntigravityDesktopStable -ExecutablePath $path -TimeoutSeconds 50 -StableSeconds 3
    if (-not $stable.Stable) { throw "Antigravity Desktop did not become stable." }
    Write-JsonResult ([pscustomobject]@{ ok = $true; launched = $true })
}

try {
    if ($Action -in @("HasDesktop", "PauseDesktop", "ResumeDesktop")) {
        . (Join-Path $PSScriptRoot "antigravity-desktop.ps1")
    }
    $inputValue = Read-JsonInput
    switch ($Action) {
        "HasCredential" { Invoke-HasCredential }
        "Capture" { Invoke-Capture }
        "Restore" { Invoke-Restore $inputValue }
        "HasDesktop" { Invoke-HasDesktop }
        "PauseDesktop" { Invoke-PauseDesktop $inputValue }
        "ResumeDesktop" { Invoke-ResumeDesktop $inputValue }
    }
} catch {
    [Console]::Error.WriteLine("Antigravity account helper failed.")
    exit 1
}
