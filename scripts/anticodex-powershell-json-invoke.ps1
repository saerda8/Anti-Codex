#Requires -Version 5.1
Set-StrictMode -Version Latest

function ConvertTo-AntiCodexPowerShellLiteral {
    param([string]$Value)
    return "'" + ($Value -replace "'", "''") + "'"
}

function Get-AntiCodexJsonExitCode {
    param($Parsed)
    if ($null -eq $Parsed) { return 1 }
    if ($Parsed.PSObject.Properties.Name -contains "error") {
        $errorName = [string]$Parsed.error
        if ($errorName -in @("explicit_start_login_approval_missing", "second_account_login_not_ready", "windows_user_not_ready_for_interactive_login")) {
            return 2
        }
    }
    if ($Parsed.PSObject.Properties.Name -contains "ok" -and $Parsed.ok -eq $false) {
        return 1
    }
    return 0
}

function Invoke-AntiCodexPowerShellJsonScript {
    param(
        [Parameter(Mandatory = $true)][string]$ScriptPath,
        [string[]]$Arguments = @(),
        [int]$TailLength = 800
    )

    if (-not (Test-Path -LiteralPath $ScriptPath -PathType Leaf)) {
        return [ordered]@{
            exitCode = 127
            ok = $false
            parsed = $null
            parseError = "missing script: $ScriptPath"
            stdoutTail = ""
            inProcessPowerShell = $true
        }
    }

    $parts = New-Object System.Collections.Generic.List[string]
    $parts.Add("&") | Out-Null
    $parts.Add((ConvertTo-AntiCodexPowerShellLiteral $ScriptPath)) | Out-Null
    foreach ($arg in $Arguments) {
        $text = [string]$arg
        if ($text -match '^-[A-Za-z][A-Za-z0-9_-]*$') {
            $parts.Add($text) | Out-Null
        } else {
            $parts.Add((ConvertTo-AntiCodexPowerShellLiteral $text)) | Out-Null
        }
    }

    $ps = [System.Management.Automation.PowerShell]::Create()
    try {
        [void]$ps.AddScript(($parts -join " "))
        $output = @($ps.Invoke())
        $stderr = (($ps.Streams.Error | ForEach-Object { [string]$_ }) -join "`n").Trim()
        $text = (($output | ForEach-Object { [string]$_ }) -join "`n").Trim()
        if ($stderr) {
            $text = (@($text, $stderr) | Where-Object { $_ }) -join "`n"
        }

        $parsed = $null
        $parseError = ""
        if ($text) {
            try {
                $parsed = $text | ConvertFrom-Json
            } catch {
                $parseError = $_.Exception.Message
            }
        }
        $parseOk = ($null -ne $parsed -and $parseError -eq "")
        return [ordered]@{
            exitCode = if ($parseOk) { Get-AntiCodexJsonExitCode -Parsed $parsed } else { 1 }
            ok = $parseOk
            parsed = $parsed
            parseError = $parseError
            stdoutTail = if ($text.Length -gt $TailLength) { $text.Substring($text.Length - $TailLength) } else { $text }
            inProcessPowerShell = $true
        }
    } catch {
        $message = $_.Exception.Message
        return [ordered]@{
            exitCode = 1
            ok = $false
            parsed = $null
            parseError = $message
            stdoutTail = if ($message.Length -gt $TailLength) { $message.Substring($message.Length - $TailLength) } else { $message }
            inProcessPowerShell = $true
        }
    } finally {
        try { $ps.Dispose() } catch {}
    }
}
