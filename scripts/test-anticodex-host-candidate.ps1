#Requires -Version 5.1
param(
    [Parameter(Mandatory = $true)]
    [string]$CandidateRoot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Drawing

function Get-AntiCodexSha256 {
    param([Parameter(Mandatory = $true)][string]$Path)

    $stream = [IO.File]::OpenRead($Path)
    $hasher = [Security.Cryptography.SHA256]::Create()
    try {
        $hash = $hasher.ComputeHash($stream)
        return [BitConverter]::ToString($hash).Replace("-", "")
    } finally {
        $hasher.Dispose()
        $stream.Dispose()
    }
}

function Test-AntiCodexIconPalette {
    param([Parameter(Mandatory = $true)][string]$Path)

    $bytes = [IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -lt 22 -or [BitConverter]::ToUInt16($bytes, 0) -ne 0 -or [BitConverter]::ToUInt16($bytes, 2) -ne 1) {
        throw "Anti-Codex icon is not a valid ICO: $Path"
    }
    $count = [BitConverter]::ToUInt16($bytes, 4)
    $best = $null
    for ($i = 0; $i -lt $count; $i += 1) {
        $entry = 6 + ($i * 16)
        $width = [int]$bytes[$entry]
        if ($width -eq 0) { $width = 256 }
        $size = [int][BitConverter]::ToUInt32($bytes, $entry + 8)
        $offset = [int][BitConverter]::ToUInt32($bytes, $entry + 12)
        if ($null -eq $best -or $width -gt $best.Width) {
            $best = [pscustomobject]@{ Width = $width; Size = $size; Offset = $offset }
        }
    }
    if ($null -eq $best -or $best.Offset -lt 0 -or ($best.Offset + $best.Size) -gt $bytes.Length) {
        throw "Anti-Codex icon has an invalid ICO frame table: $Path"
    }

    $frame = New-Object byte[] $best.Size
    [Array]::Copy($bytes, $best.Offset, $frame, 0, $best.Size)
    $stream = New-Object IO.MemoryStream(,$frame)
    $image = [System.Drawing.Image]::FromStream($stream)
    $bitmap = New-Object System.Drawing.Bitmap $image
    try {
        $pinkBlob = 0
        $whiteCommand = 0
        $tealBackground = 0
        $originalBluePurple = 0
        $transparent = 0
        $solid = 0
        for ($y = 0; $y -lt $bitmap.Height; $y += 8) {
            for ($x = 0; $x -lt $bitmap.Width; $x += 8) {
                $pixel = $bitmap.GetPixel($x, $y)
                if ($pixel.A -lt 10) {
                    $transparent += 1
                    continue
                }
                $solid += 1
                if ($pixel.R -gt 205 -and $pixel.B -gt 135 -and $pixel.G -lt 165) { $pinkBlob += 1 }
                if ($pixel.R -gt 230 -and $pixel.G -gt 230 -and $pixel.B -gt 230) { $whiteCommand += 1 }
                if ($pixel.R -ge 30 -and $pixel.R -le 95 -and $pixel.G -ge 105 -and $pixel.G -le 170 -and $pixel.B -ge 120 -and $pixel.B -le 180) { $tealBackground += 1 }
                if ($pixel.B -gt 185 -and $pixel.R -lt 190 -and $pixel.G -lt 185) { $originalBluePurple += 1 }
            }
        }
        return [pscustomobject]@{
            width = $bitmap.Width
            height = $bitmap.Height
            pinkBlobSamples = $pinkBlob
            whiteCommandSamples = $whiteCommand
            tealBackgroundSamples = $tealBackground
            originalBluePurpleSamples = $originalBluePurple
            transparentSamples = $transparent
            solidSamples = $solid
            ok = ($pinkBlob -ge 120 -and $whiteCommand -ge 10 -and $transparent -ge 100 -and $tealBackground -le 3 -and $originalBluePurple -le 10)
        }
    } finally {
        $bitmap.Dispose()
        $image.Dispose()
        $stream.Dispose()
    }
}

function Test-AntiCodexCrashRecoveryPage {
    param([Parameter(Mandatory = $true)][string]$Text)

    $identifier = '[A-Za-z_$][\w$]*'
    function Test-SupportedControlAssignments {
        param([string]$Region, [string]$Variable, [string]$MemoPattern)
        $name = [regex]::Escape($Variable)
        $declarations = [regex]::Matches($Region, "\blet $name;")
        if ($declarations.Count -ne 1) { return $false }
        $afterDeclaration = $declarations[0].Index + $declarations[0].Length
        $statementTerminator = $Region.IndexOf(";", $afterDeclaration)
        $nextDeclaration = [regex]::Match($Region.Substring($afterDeclaration), "\blet [A-Za-z_$][\w$]*;")
        $segmentEnd = if ($statementTerminator -ge 0) { $statementTerminator + 1 } elseif ($nextDeclaration.Success) { $afterDeclaration + $nextDeclaration.Index } else { $Region.Length }
        $segment = $Region.Substring($declarations[0].Index, $segmentEnd - $declarations[0].Index)
        $identifierPattern = "(?<![.\w`$])$name(?![\w`$])"
        $writePattern = "(?:$identifierPattern\s*(?:\+\+|--|\*\*=|>>>=|<<=|>>=|&&=|\|\|=|\?\?=|[+\-*/%&|^]=|=(?!=|>))|(?:\+\+|--)\s*$identifierPattern|(?<![.\w`$])\[[^\[\];]{0,800}?$identifierPattern[^\[\];]{0,800}?\]\s*=|(?<![.\w`$])\{[^{};]{0,800}?$identifierPattern[^{};]{0,800}?\}\s*=|\bfor\s*\([^;)]{0,500}?$identifierPattern[^;)]{0,500}?\s+(?:of|in)\b)"
        $writes = [regex]::Matches($Region, $writePattern)
        $segmentWrites = [regex]::Matches($segment, $writePattern)
        if ($writes.Count -eq 1 -and $segmentWrites.Count -eq 1) { return $true }
        return $writes.Count -eq 2 -and $segmentWrites.Count -eq 2 -and
            -not [string]::IsNullOrWhiteSpace($MemoPattern) -and
            [regex]::Matches($segment, $MemoPattern).Count -eq 1
    }
    $v2TitlePatched = 'id:`appServerCrash\.recoveryTitle`,defaultMessage:`Anti-Codex hit a snag`(?=\})'
    $v2ConfigPatched = 'id:`appServerCrash\.configurationRecoveryDescription`,defaultMessage:`Anti-Codex couldn''t load your configuration\. Review it, then restart to try again\.`(?=\})'
    $v2DescriptionPatched = 'id:`appServerCrash\.recoveryDescription`,defaultMessage:`Something went wrong\. Restart Anti-Codex to try again\.`(?=\})'
    $v2RestartPatched = 'id:`appServerCrash\.restartChatGPT`,defaultMessage:`Restart Anti-Codex`(?=\})'
    $v3MarkerPattern = "/\*anticodex-crash-recovery-actions-v3\*/children:\[(?<restart>$identifier),(?<feedback>$identifier),(?<config>$identifier)\]"
    $modernTitleOriginal = 'id:`appServerCrash\.recoveryTitle`,defaultMessage:`ChatGPT hit a snag`,description:`[^`]+`'
    $modernTitlePatched = 'id:`appServerCrash\.recoveryTitle`,defaultMessage:`Anti-Codex hit a snag`'
    if ([regex]::Matches($Text, $modernTitlePatched).Count -eq 1 -and
        [regex]::Matches($Text, $modernTitleOriginal).Count -eq 0 -and
        [regex]::Matches($Text, 'id:`appServerCrash\.feedbackGuidance`').Count -eq 1) {
        return $true
    }
    if ([regex]::Matches($Text, $v3MarkerPattern).Count -gt 0) {
        $v3TitlePatched = 'id:`appServerCrash\.recoveryTitle`,defaultMessage:`Anti-Codex hit a snag`(?=\s*\})'
        $v3ConfigPatched = 'id:`appServerCrash\.configurationRecoveryDescription`,defaultMessage:`Anti-Codex couldn''t load your configuration\. Review it, then restart to try again\.`(?=\s*\})'
        $v3DescriptionPatched = 'id:`appServerCrash\.recoveryDescription`,defaultMessage:`Something went wrong\. Restart Anti-Codex to try again\.`(?=\s*\})'
        $v3RestartPatched = 'id:`appServerCrash\.restartChatGPT`,defaultMessage:`Restart Anti-Codex`(?=\s*\})'
        $v3RegionPattern = "(?s)function $identifier\((?<props>$identifier)\)\{.{0,16000}?$v3ConfigPatched.{0,6000}?$v3DescriptionPatched.{0,6000}?$v3RestartPatched.{0,7000}?hideUnavailable:!0.{0,3500}?$v3MarkerPattern.{0,3000}?\}function (?<openConfig>$identifier)\(\)\{return $identifier\.dispatchMessage\(``open-config-toml``,\{\}\)\}"
        $v3Regions = [regex]::Matches($Text, $v3RegionPattern)
        if ($v3Regions.Count -ne 1 -or [regex]::Matches($Text, $v3TitlePatched).Count -ne 1) {
            throw "Anti-Codex candidate must contain exactly one patched 26.901 crash region and title."
        }
        $v3Region = $v3Regions[0].Value
        $v3Props = [regex]::Escape($v3Regions[0].Groups['props'].Value)
        $v3RestartVariable = $v3Regions[0].Groups['restart'].Value
        $v3FeedbackVariable = $v3Regions[0].Groups['feedback'].Value
        $v3ConfigVariable = $v3Regions[0].Groups['config'].Value
        $v3OpenConfigName = $v3Regions[0].Groups['openConfig'].Value
        $v3Restart = [regex]::Escape($v3RestartVariable)
        $v3Feedback = [regex]::Escape($v3FeedbackVariable)
        $v3Config = [regex]::Escape($v3ConfigVariable)
        $v3OpenConfig = [regex]::Escape($v3OpenConfigName)
        $v3RestartBindings = [regex]::Matches($v3Region, "\{fatalError:$identifier,onReset:(?<handler>$identifier)\}=$v3Props(?:[,;])")
        if ($v3RestartBindings.Count -ne 1) {
            throw "Anti-Codex candidate 26.901 restart control is not bound to onReset."
        }
        $v3RestartHandler = [regex]::Escape($v3RestartBindings[0].Groups['handler'].Value)
        $v3RestartActions = [regex]::Matches($v3Region, "(?s)\b$v3Restart=[^;]{0,1200}?onClick:$v3RestartHandler,children:(?<label>$identifier)")
        $v3RestartLabel = if ($v3RestartActions.Count -eq 1) { [regex]::Escape($v3RestartActions[0].Groups['label'].Value) } else { "" }
        $v3RestartLabels = @(if ($v3RestartLabel) { [regex]::Matches($v3Region, "\b$v3RestartLabel=[^;]{0,700}?$v3RestartPatched") })
        $v3FeedbackActions = [regex]::Matches($v3Region, "(?s)\b$v3Feedback=[^;]{0,1400}?onClick:$identifier[^;]{0,900}?id:``appServerCrash\.sendFeedback``")
        $v3ConfigActions = [regex]::Matches($v3Region, "(?s)\b$v3Config=[^;]{0,1800}?onClick:(?<handler>$identifier)[^;]{0,1000}?id:``appServerCrash\.reviewConfiguration``")
        if ($v3RestartActions.Count -ne 1 -or $v3RestartLabels.Count -ne 1 -or
            $v3FeedbackActions.Count -ne 1 -or $v3ConfigActions.Count -ne 1 -or
            $v3ConfigActions[0].Groups['handler'].Value -ne $v3OpenConfigName -or
            [regex]::Matches($Text, "function $v3OpenConfig\(\)\{return $identifier\.dispatchMessage\(``open-config-toml``,\{\}\)\}").Count -ne 1 -or
            [regex]::Matches($v3Region, "children:\[$v3Restart,$v3Feedback,$v3Config,$identifier\]").Count -ne 0) {
            throw "Anti-Codex candidate 26.901 crash actions are incomplete or still render the updater."
        }
        $v3OriginalPatterns = @(
            'id:`appServerCrash\.recoveryTitle`,defaultMessage:`ChatGPT hit a snag`,description:`[^`]+`',
            'id:`appServerCrash\.configurationRecoveryDescription`,defaultMessage:`ChatGPT couldn''t load your configuration\. Review it, then restart to try again\.`,description:`[^`]+`',
            'id:`appServerCrash\.recoveryDescription`,defaultMessage:`Something went wrong\. Restart ChatGPT to try again\.`,description:`[^`]+`',
            'id:`appServerCrash\.restartChatGPT`,defaultMessage:`Restart ChatGPT`,description:`[^`]+`'
        )
        if (@($v3OriginalPatterns | Where-Object { [regex]::Matches($Text, $_).Count -ne 0 }).Count -ne 0 -or
            [regex]::Matches($Text, $v3ConfigPatched).Count -ne 1 -or
            [regex]::Matches($Text, $v3DescriptionPatched).Count -ne 1 -or
            [regex]::Matches($Text, $v3RestartPatched).Count -ne 1 -or
            [regex]::Matches($Text, $v3MarkerPattern).Count -ne 1) {
            throw "Anti-Codex candidate 26.901 crash recovery markers are incomplete or duplicated."
        }
        return $true
    }
    if ([regex]::Matches($Text, 'id:`appServerCrash\.recoveryTitle`').Count -gt 0) {
        $v2AppRegionPattern = "(?s)function $identifier\((?<props>$identifier)\)\{(?:(?!function $identifier\()[\s\S]){0,9000}?$v2TitlePatched(?:(?!function $identifier\()[\s\S]){0,9000}?$v2ConfigPatched(?:(?!function $identifier\()[\s\S]){0,9000}?$v2DescriptionPatched(?:(?!function $identifier\()[\s\S]){0,9000}?$v2RestartPatched(?:(?!function $identifier\()[\s\S]){0,9000}?hideUnavailable:!0(?:(?!function $identifier\()[\s\S]){0,4000}?/\*anticodex-crash-recovery-actions-v2\*/children:\[$identifier,$identifier,$identifier\](?:(?!function $identifier\()[\s\S]){0,4000}?\}function $identifier\(\)\{return $identifier\.dispatchMessage\(``open-config-toml``,\{\}\)\}"
        $v2AppRegions = [regex]::Matches($Text, $v2AppRegionPattern)
        if ($v2AppRegions.Count -ne 1) {
            throw "Anti-Codex candidate must contain exactly one patched 26.825 app-server crash region."
        }
        $appRegion = $v2AppRegions[0].Value
        $appProps = [regex]::Escape($v2AppRegions[0].Groups['props'].Value)
        $actionMatches = [regex]::Matches($appRegion, "/\*anticodex-crash-recovery-actions-v2\*/children:\[(?<restart>$identifier),(?<feedback>$identifier),(?<config>$identifier)\]")
        if ($actionMatches.Count -ne 1) {
            throw "Anti-Codex candidate 26.825 crash actions are missing or ambiguous."
        }
        $restartVariable = $actionMatches[0].Groups['restart'].Value
        $feedbackVariable = $actionMatches[0].Groups['feedback'].Value
        $configVariable = $actionMatches[0].Groups['config'].Value
        $restart = [regex]::Escape($restartVariable)
        $feedback = [regex]::Escape($feedbackVariable)
        $config = [regex]::Escape($configVariable)

        $restartBindings = [regex]::Matches($appRegion, "\{fatalError:$identifier,onReset:(?<handler>$identifier)\}=$appProps(?:[,;])")
        if ($restartBindings.Count -ne 1) {
            throw "Anti-Codex candidate 26.825 restart control is not bound to the component onReset handler."
        }
        $restartHandler = [regex]::Escape($restartBindings[0].Groups['handler'].Value)
        $restartPattern = "(?s)let (?<label>$identifier);[\s\S]{0,650}?\b\k<label>=[\s\S]{0,350}?id:``appServerCrash\.restartChatGPT``,defaultMessage:``Restart Anti-Codex``(?=\})[\s\S]{0,350}?let $restart;[\s\S]{0,450}?\b$restart=[\s\S]{0,220}?onClick:$restartHandler,children:\k<label>"
        $restartMatches = [regex]::Matches($appRegion, $restartPattern)
        $restartLabel = if ($restartMatches.Count -eq 1) { [regex]::Escape($restartMatches[0].Groups['label'].Value) } else { "" }
        $restartMemoPattern = "^let $restart;(?<cache>$identifier)\[(?<dependencyIndex>\d+)\]===$restartHandler\?$restart=\k<cache>\[(?<valueIndex>\d+)\]:\($restart=(?:(?!=>|function)[\s\S]){1,600}?onClick:$restartHandler,children:$restartLabel(?:(?!=>|function)[\s\S]){0,150}?,\k<cache>\[\k<dependencyIndex>\]=$restartHandler,\k<cache>\[\k<valueIndex>\]=$restart\);?$"
        if ($restartMatches.Count -ne 1 -or -not (Test-SupportedControlAssignments -Region $appRegion -Variable $restartVariable -MemoPattern $restartMemoPattern)) {
            throw "Anti-Codex candidate 26.825 crash actions do not retain the restart control."
        }

        $feedbackMatches = [regex]::Matches($appRegion, "\b$feedback=[^;]{0,900}?onClick:$identifier[^;]{0,700}?id:``appServerCrash\.sendFeedback``")
        if ($feedbackMatches.Count -ne 1) {
            throw "Anti-Codex candidate 26.825 crash actions do not retain the feedback control."
        }

        $configMatches = [regex]::Matches($appRegion, "\b$config=[^;]{0,1200}?onClick:(?<openConfig>$identifier)[^;]{0,800}?id:``appServerCrash\.reviewConfiguration``")
        $openConfigName = if ($configMatches.Count -eq 1) { $configMatches[0].Groups['openConfig'].Value } else { "" }
        $openConfig = [regex]::Escape($openConfigName)
        $dependency = "$identifier(?:\.$identifier)*"
        $configMemoPattern = "^let $config;(?<cache>$identifier)\[(?<firstIndex>\d+)\]!==?(?<first>$dependency)\|\|\k<cache>\[(?<secondIndex>\d+)\]!==?(?<second>$dependency)\?\($config=(?:(?!=>|function)[\s\S]){1,1300}?onClick:$openConfig(?:(?!=>|function)[\s\S]){1,900}?id:``appServerCrash\.reviewConfiguration``(?:(?!=>|function)[\s\S]){0,500}?,\k<cache>\[\k<firstIndex>\]=\k<first>,\k<cache>\[\k<secondIndex>\]=\k<second>,\k<cache>\[(?<valueIndex>\d+)\]=$config\):$config=\k<cache>\[\k<valueIndex>\];?$"
        if ($configMatches.Count -ne 1 -or -not (Test-SupportedControlAssignments -Region $appRegion -Variable $configVariable -MemoPattern $configMemoPattern)) {
            throw "Anti-Codex candidate 26.825 crash actions do not retain the config control."
        }
        if ([regex]::Matches($Text, "function $openConfig\(\)\{return $identifier\.dispatchMessage\(``open-config-toml``,\{\}\)\}").Count -ne 1) {
            throw "Anti-Codex candidate 26.825 config control is not bound to the isolated config dispatcher."
        }
        if ([regex]::Matches($appRegion, "children:\[$restart,$feedback,$config,$identifier\]").Count -ne 0) {
            throw "Anti-Codex candidate 26.825 crash page still renders the upstream updater."
        }

        $genericRegionPattern = "(?s)function $identifier\((?<props>$identifier)\)\{(?:(?!function $identifier\()[\s\S]){0,1800}?id:``codex\.errorBoundary\.genericError``,defaultMessage:``Oops, an error has occurred``(?=\})(?:(?!function $identifier\()[\s\S]){0,1800}?id:``codex\.errorBoundary\.goHome``,defaultMessage:``Try again``(?=\})(?:(?!function $identifier\()[\s\S]){0,1800}?\}var $identifier(?:,$identifier){2,}"
        $genericRegions = [regex]::Matches($Text, $genericRegionPattern)
        if ($genericRegions.Count -ne 1) {
            throw "Anti-Codex candidate must contain exactly one patched generic error region."
        }
        $genericRegion = $genericRegions[0].Value
        $genericProps = [regex]::Escape($genericRegions[0].Groups['props'].Value)
        $resetBindings = [regex]::Matches($genericRegion, "\{resetError:(?<handler>$identifier)\}=$genericProps(?:[,;])")
        $genericActionPattern = "(?s)(?<retryLabel>$identifier)=\(0,$identifier\.jsx\)\($identifier,\{id:``codex\.errorBoundary\.goHome``,defaultMessage:``Try again``\}\)[\s\S]{0,1200}?/\*anticodex-generic-error-actions\*/children:\[\(0,$identifier\.jsx\)\($identifier,\{onClick:(?<retryHandler>$identifier),children:\k<retryLabel>\}\)\]"
        $genericActions = [regex]::Matches($genericRegion, $genericActionPattern)
        if ($resetBindings.Count -ne 1 -or $genericActions.Count -ne 1) {
            throw "Anti-Codex candidate generic error page does not retain exactly one retry action."
        }
        $resetHandler = [regex]::Escape($resetBindings[0].Groups['handler'].Value)
        $retryHandlerVariable = $genericActions[0].Groups['retryHandler'].Value
        $retryHandler = [regex]::Escape($retryHandlerVariable)
        $retryMemoPattern = "^let $retryHandler;(?<cache>$identifier)\[(?<routeIndex>\d+)\]!==?(?<route>$identifier)\|\|\k<cache>\[(?<resetIndex>\d+)\]!==?$resetHandler\?\($retryHandler=\(\)=>\{$resetHandler\(\),\k<route>\(``/``\)\},\k<cache>\[\k<routeIndex>\]=\k<route>,\k<cache>\[\k<resetIndex>\]=$resetHandler,\k<cache>\[(?<valueIndex>\d+)\]=$retryHandler\):$retryHandler=\k<cache>\[\k<valueIndex>\];?$"
        if ([regex]::Matches($genericRegion, "\b$retryHandler=\(\)=>\{?$resetHandler\(\)(?:[,;}])").Count -ne 1 -or
            -not (Test-SupportedControlAssignments -Region $genericRegion -Variable $retryHandlerVariable -MemoPattern $retryMemoPattern) -or
            [regex]::Matches($genericRegion, "children:\[$identifier,\(0,$identifier\.jsx\)\($identifier,\{onClick:$identifier,children:$identifier\}\)\]").Count -ne 0) {
            throw "Anti-Codex candidate generic error retry is incomplete or still renders the updater."
        }

        $v2TitleOriginal = 'id:`appServerCrash\.recoveryTitle`,defaultMessage:`ChatGPT hit a snag`,description:`[^`]+`'
        $v2ConfigOriginal = 'id:`appServerCrash\.configurationRecoveryDescription`,defaultMessage:`ChatGPT couldn''t load your configuration\. Review it, then restart to try again\.`,description:`[^`]+`'
        $v2DescriptionOriginal = 'id:`appServerCrash\.recoveryDescription`,defaultMessage:`Something went wrong\. Restart ChatGPT to try again\.`,description:`[^`]+`'
        $v2RestartOriginal = 'id:`appServerCrash\.restartChatGPT`,defaultMessage:`Restart ChatGPT`,description:`[^`]+`'
        $genericTitleOriginal = 'id:`codex\.errorBoundary\.genericError`,defaultMessage:`Oops, an error has occurred`,description:`Generic error message shown when the extension webview fails`'
        $genericRetryOriginal = 'id:`codex\.errorBoundary\.goHome`,defaultMessage:`Try again`,description:`Button label to navigate to the home page after an error`'
        if ([regex]::Matches($Text, $v2TitleOriginal).Count -ne 0 -or
            [regex]::Matches($Text, $v2ConfigOriginal).Count -ne 0 -or
            [regex]::Matches($Text, $v2DescriptionOriginal).Count -ne 0 -or
            [regex]::Matches($Text, $v2RestartOriginal).Count -ne 0 -or
            [regex]::Matches($Text, $v2TitlePatched).Count -ne 1 -or
            [regex]::Matches($Text, $v2ConfigPatched).Count -ne 1 -or
            [regex]::Matches($Text, $v2DescriptionPatched).Count -ne 1 -or
            [regex]::Matches($Text, $v2RestartPatched).Count -ne 1 -or
            [regex]::Matches($Text, $genericTitleOriginal).Count -ne 1 -or
            [regex]::Matches($Text, $genericRetryOriginal).Count -ne 1) {
            throw "Anti-Codex candidate 26.825 crash recovery page markers are incomplete or duplicated."
        }
        return $true
    }
    $titlePatched = 'id:`appServerCrash\.title`,defaultMessage:`\{appName\} stopped unexpectedly`,values:\{appName:`Anti-Codex`\}'
    $descriptionPatched = 'id:`appServerCrash\.description`,defaultMessage:`Restart \{appName\} to continue\. If the problem persists, check your configuration or visit the \{documentationLink\}`,values:\{appName:`Anti-Codex`,documentationLink:'
    $appRegionPattern = "(?s)function $identifier\((?<props>$identifier)\)\{(?:(?!function $identifier\()[\s\S]){0,2500}?$titlePatched(?:(?!function $identifier\()[\s\S]){0,2500}?$descriptionPatched(?:(?!function $identifier\()[\s\S]){0,8000}?id:``appServerCrash\.restart``,defaultMessage:``Restart``(?:(?!function $identifier\()[\s\S]){0,3000}?\}function $identifier\(\)\{return $identifier\.dispatchMessage\(``open-config-toml``,\{\}\)\}"
    $appRegions = [regex]::Matches($Text, $appRegionPattern)
    if ($appRegions.Count -ne 1) {
        throw "Anti-Codex candidate must contain exactly one patched app-server crash region."
    }
    $appRegion = $appRegions[0].Value
    $appProps = [regex]::Escape($appRegions[0].Groups['props'].Value)
    $actionMatches = [regex]::Matches($appRegion, "/\*anticodex-crash-recovery-actions\*/children:\[(?<config>$identifier),(?<restart>$identifier)\]")
    if ($actionMatches.Count -ne 1) {
        throw "Anti-Codex candidate app-server crash actions are missing or ambiguous."
    }
    $configVariable = $actionMatches[0].Groups['config'].Value
    $restartVariable = $actionMatches[0].Groups['restart'].Value
    $config = [regex]::Escape($configVariable)
    $restart = [regex]::Escape($restartVariable)
    $configMatches = [regex]::Matches($appRegion, "\b$config=[^;]{0,700}?onClick:(?<openConfig>$identifier)[^;]{0,500}?id:``loadingPage\.openConfigToml``")
    $configHandlerName = if ($configMatches.Count -eq 1) { [regex]::Escape($configMatches[0].Groups['openConfig'].Value) } else { "" }
    $dependency = "$identifier(?:\.$identifier)*"
    $configMemoPattern = "^let $config;(?<cache>$identifier)\[(?<dependencyIndex>\d+)\]===(?<dependency>$dependency)\?$config=\k<cache>\[(?<valueIndex>\d+)\]:\($config=(?:(?!=>|function)[\s\S]){1,900}?onClick:$configHandlerName(?:(?!=>|function)[\s\S]){1,700}?id:``loadingPage\.openConfigToml``(?:(?!=>|function)[\s\S]){0,400}?,\k<cache>\[\k<dependencyIndex>\]=\k<dependency>,\k<cache>\[\k<valueIndex>\]=$config\);?$"
    if ($configMatches.Count -ne 1 -or -not (Test-SupportedControlAssignments -Region $appRegion -Variable $configVariable -MemoPattern $configMemoPattern)) {
        throw "Anti-Codex candidate crash actions do not retain the config control."
    }
    $openConfig = [regex]::Escape($configMatches[0].Groups['openConfig'].Value)
    if ([regex]::Matches($Text, "function $openConfig\(\)\{return $identifier\.dispatchMessage\(``open-config-toml``,\{\}\)\}").Count -ne 1) {
        throw "Anti-Codex candidate config control is not bound to the isolated config dispatcher."
    }
    $restartBindings = [regex]::Matches($appRegion, "\{fatalError:$identifier,onReset:(?<handler>$identifier)\}=$appProps(?:[,;])")
    if ($restartBindings.Count -ne 1) {
        throw "Anti-Codex candidate restart control is not bound to the component onReset handler."
    }
    $restartHandler = [regex]::Escape($restartBindings[0].Groups['handler'].Value)
    $restartPattern = "(?s)let (?<label>$identifier);[\s\S]{0,450}?\b\k<label>=[\s\S]{0,300}?id:``appServerCrash\.restart``,defaultMessage:``Restart``[\s\S]{0,250}?let $restart;[\s\S]{0,350}?\b$restart=[\s\S]{0,180}?onClick:$restartHandler,children:\k<label>"
    $restartMatches = [regex]::Matches($appRegion, $restartPattern)
    $restartLabel = if ($restartMatches.Count -eq 1) { [regex]::Escape($restartMatches[0].Groups['label'].Value) } else { "" }
    $restartMemoPattern = "^let $restart;(?<cache>$identifier)\[(?<dependencyIndex>\d+)\]===$restartHandler\?$restart=\k<cache>\[(?<valueIndex>\d+)\]:\($restart=(?:(?!=>|function)[\s\S]){1,600}?onClick:$restartHandler,children:$restartLabel(?:(?!=>|function)[\s\S]){0,150}?,\k<cache>\[\k<dependencyIndex>\]=$restartHandler,\k<cache>\[\k<valueIndex>\]=$restart\);?$"
    if ($restartMatches.Count -ne 1 -or
        -not (Test-SupportedControlAssignments -Region $appRegion -Variable $restartVariable -MemoPattern $restartMemoPattern) -or
        [regex]::Matches($appRegion, "children:\[$identifier,$config,$restart\]").Count -ne 0) {
        throw "Anti-Codex candidate crash actions do not retain only config and restart."
    }

    $genericRegionPattern = "(?s)function $identifier\((?<props>$identifier)\)\{(?:(?!function $identifier\()[\s\S]){0,1800}?id:``codex\.errorBoundary\.genericError``,defaultMessage:``Oops, an error has occurred``(?=\})(?:(?!function $identifier\()[\s\S]){0,1800}?id:``codex\.errorBoundary\.goHome``,defaultMessage:``Try again``(?=\})(?:(?!function $identifier\()[\s\S]){0,1800}?\}var $identifier(?:,$identifier){2,}"
    $genericRegions = [regex]::Matches($Text, $genericRegionPattern)
    if ($genericRegions.Count -ne 1) {
        throw "Anti-Codex candidate must contain exactly one patched generic error region."
    }
    $genericRegion = $genericRegions[0].Value
    $genericProps = [regex]::Escape($genericRegions[0].Groups['props'].Value)
    $resetBindings = [regex]::Matches($genericRegion, "\{resetError:(?<handler>$identifier)\}=$genericProps(?:[,;])")
    $genericActionPattern = "(?s)(?<retryLabel>$identifier)=\(0,$identifier\.jsx\)\($identifier,\{id:``codex\.errorBoundary\.goHome``,defaultMessage:``Try again``\}\)[\s\S]{0,1200}?/\*anticodex-generic-error-actions\*/children:\[\(0,$identifier\.jsx\)\($identifier,\{onClick:(?<retryHandler>$identifier),children:\k<retryLabel>\}\)\]"
    $genericActions = [regex]::Matches($genericRegion, $genericActionPattern)
    if ($resetBindings.Count -ne 1 -or $genericActions.Count -ne 1) {
        throw "Anti-Codex candidate generic error page does not retain exactly one retry action."
    }
    $resetHandler = [regex]::Escape($resetBindings[0].Groups['handler'].Value)
    $retryHandlerVariable = $genericActions[0].Groups['retryHandler'].Value
    $retryHandler = [regex]::Escape($retryHandlerVariable)
    $retryMemoPattern = "^let $retryHandler;(?<cache>$identifier)\[(?<routeIndex>\d+)\]!==?(?<route>$identifier)\|\|\k<cache>\[(?<resetIndex>\d+)\]!==?$resetHandler\?\($retryHandler=\(\)=>\{$resetHandler\(\),\k<route>\(``/``\)\},\k<cache>\[\k<routeIndex>\]=\k<route>,\k<cache>\[\k<resetIndex>\]=$resetHandler,\k<cache>\[(?<valueIndex>\d+)\]=$retryHandler\):$retryHandler=\k<cache>\[\k<valueIndex>\];?$"
    if ([regex]::Matches($genericRegion, "\b$retryHandler=\(\)=>\{?$resetHandler\(\)(?:[,;}])").Count -ne 1 -or
        -not (Test-SupportedControlAssignments -Region $genericRegion -Variable $retryHandlerVariable -MemoPattern $retryMemoPattern)) {
        throw "Anti-Codex candidate generic error retry does not invoke the error boundary reset handler."
    }
    if ([regex]::Matches($genericRegion, "children:\[$identifier,\(0,$identifier\.jsx\)\($identifier,\{onClick:$identifier,children:$identifier\}\)\]").Count -ne 0) {
        throw "Anti-Codex candidate generic error page still renders the upstream updater."
    }

    $titleOriginal = 'id:`appServerCrash\.title`,defaultMessage:`\{appName\} stopped unexpectedly`,description:`[^`]+`,values:\{appName:[A-Za-z_$][\w$]*\}'
    $descriptionOriginal = 'id:`appServerCrash\.description`,defaultMessage:`Restart \{appName\} to continue\. If the problem persists, check your configuration or visit the \{documentationLink\}`,description:`[^`]+`,values:\{appName:[A-Za-z_$][\w$]*,documentationLink:'
    $genericTitleOriginal = 'id:`codex\.errorBoundary\.genericError`,defaultMessage:`Oops, an error has occurred`,description:`Generic error message shown when the extension webview fails`'
    $genericRetryOriginal = 'id:`codex\.errorBoundary\.goHome`,defaultMessage:`Try again`,description:`Button label to navigate to the home page after an error`'
    if ([regex]::Matches($Text, $titleOriginal).Count -ne 0 -or
        [regex]::Matches($Text, $descriptionOriginal).Count -ne 0 -or
        [regex]::Matches($Text, $titlePatched).Count -ne 1 -or
        [regex]::Matches($Text, $descriptionPatched).Count -ne 1 -or
        [regex]::Matches($Text, $genericTitleOriginal).Count -ne 1 -or
        [regex]::Matches($Text, $genericRetryOriginal).Count -ne 1) {
        throw "Anti-Codex candidate crash recovery page markers are incomplete or duplicated."
    }
    return $true
}

$candidate = [IO.Path]::GetFullPath($CandidateRoot)
$expectedCandidate = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA "Anti-Codex\update-candidate"))
if ($candidate -ne $expectedCandidate) {
    throw "Anti-Codex candidate validation may only run for $expectedCandidate"
}

$candidateAppRoot = Join-Path $candidate "codex-patched-app"
$detectedDesktopHost = $null
foreach ($hostName in @("ChatGPT.exe", "Codex.exe")) {
    if (Test-Path -LiteralPath (Join-Path $candidateAppRoot $hostName) -PathType Leaf) {
        $detectedDesktopHost = $hostName
        break
    }
}
if (-not $detectedDesktopHost) {
    throw "Anti-Codex candidate is missing a desktop host executable (ChatGPT.exe or Codex.exe)."
}

$required = @(
    (Join-Path $candidate "codex-patched-app.ok"),
    (Join-Path $candidateAppRoot "Anti-Codex.exe"),
    (Join-Path $candidateAppRoot $detectedDesktopHost),
    (Join-Path $candidateAppRoot "resources\app.asar"),
    (Join-Path $candidateAppRoot "resources\codex.exe"),
    (Join-Path $candidateAppRoot "resources\codex-windows-sandbox-setup.exe"),
    (Join-Path $candidateAppRoot "resources\cua_node\bin\node_repl.exe"),
    (Join-Path $candidateAppRoot "resources\cua_node\bin\node.exe"),
    (Join-Path $candidateAppRoot "resources\icon.ico"),
    (Join-Path $candidateAppRoot "resources\codex-tray.ico"),
    (Join-Path $candidateAppRoot "icon.ico")
)
foreach ($path in $required) {
    if (-not (Test-Path -LiteralPath $path)) {
        throw "Anti-Codex candidate is incomplete: $path"
    }
}

$markerPath = Join-Path $candidate "codex-patched-app.ok"
$manifest = Get-Content -LiteralPath $markerPath -Raw | ConvertFrom-Json
if ($manifest.schema -ne "anticodex-host-manifest-v2") {
    throw "Anti-Codex candidate marker schema is invalid."
}
if (($manifest.PSObject.Properties.Name -notcontains "patchProfile") -or [string]$manifest.patchProfile -ne "fixed-shell-v1") {
    throw "Anti-Codex candidate marker patch profile is invalid."
}
if (($manifest.PSObject.Properties.Name -notcontains "hostPatchRevision") -or [string]$manifest.hostPatchRevision -ne "7") {
    throw "Anti-Codex candidate marker patch revision is invalid."
}
$expectedFixedShellCriticalPatches = @(
    "package-json",
    "webview-html-title",
    "app-name",
    "app-user-model-id",
    "session-title",
    "model-switch-warning",
    "model-upgrade-banner",
    "startup-mcp-config-reload",
    "app-server-managed-session-flags",
    "config-write",
    "auth-requirement",
    "app-route-gate",
    "profile-dropdown-settings",
    "settings-external-links",
    "crash-recovery-page",
    "browser-window-icon",
    "windows-tray-icon",
    "local-model-availability"
)
$recordedCriticalPatches = @($manifest.criticalPatches)
if (($recordedCriticalPatches.Count -ne $expectedFixedShellCriticalPatches.Count) -or
    (@($expectedFixedShellCriticalPatches | Where-Object { $_ -notin $recordedCriticalPatches }).Count -gt 0)) {
    throw "Anti-Codex candidate marker is missing critical compatibility patches."
}
$recordedFiles = @()
$recordedFilesProperty = $manifest.PSObject.Properties["unpackedFiles"]
if ($recordedFilesProperty) {
    $recordedFiles = @($recordedFilesProperty.Value)
}
if ($recordedFiles.Count -eq 0) {
    throw "Anti-Codex candidate marker is missing unpacked file inventory."
}
$candidateAppRootFull = [IO.Path]::GetFullPath($candidateAppRoot).TrimEnd("\")
$candidateUnpackedRoot = [IO.Path]::GetFullPath((Join-Path $candidateAppRootFull "resources\app.asar.unpacked")).TrimEnd("\")
$candidateUnpackedPrefix = "$candidateUnpackedRoot\"
$recordedPaths = New-Object "System.Collections.Generic.HashSet[string]" ([StringComparer]::OrdinalIgnoreCase)
foreach ($recordedFile in $recordedFiles) {
    $relativePath = [string]$recordedFile.path
    $recordedHash = [string]$recordedFile.sha256
    $recordedSizeProperty = $recordedFile.PSObject.Properties["size"]
    if (-not $relativePath -or -not $recordedHash -or -not $recordedSizeProperty -or [IO.Path]::IsPathRooted($relativePath)) {
        throw "Anti-Codex candidate marker contains an invalid unpacked file entry."
    }
    $unpackedFilePath = [IO.Path]::GetFullPath((Join-Path $candidateAppRootFull $relativePath))
    $unpackedFileAccessPath = "\\?\$unpackedFilePath"
    if (-not $unpackedFilePath.StartsWith($candidateUnpackedPrefix, [StringComparison]::OrdinalIgnoreCase) -or
        -not [IO.File]::Exists($unpackedFileAccessPath)) {
        throw "Anti-Codex candidate unpacked file is missing or outside app.asar.unpacked: $relativePath"
    }
    if ([string](Get-AntiCodexSha256 -Path $unpackedFileAccessPath) -ne $recordedHash) {
        throw "Anti-Codex candidate unpacked file hash mismatch: $relativePath"
    }
    if ([long](Get-Item -LiteralPath $unpackedFileAccessPath).Length -ne [long]$recordedSizeProperty.Value) {
        throw "Anti-Codex candidate unpacked file size mismatch: $relativePath"
    }
    if (-not $recordedPaths.Add($unpackedFilePath)) {
        throw "Anti-Codex candidate marker repeats an unpacked file path: $relativePath"
    }
}
$actualFiles = @(Get-ChildItem -LiteralPath "\\?\$candidateUnpackedRoot" -File -Recurse -Force -ErrorAction Stop)
if ($actualFiles.Count -ne $recordedFiles.Count) {
    throw "Anti-Codex candidate unpacked file inventory is incomplete."
}

$antiCodex = Join-Path $candidateAppRoot "Anti-Codex.exe"
$asarPath = Join-Path $candidateAppRoot "resources\app.asar"
$codex = Join-Path $candidateAppRoot "resources\codex.exe"
$nodeRuntime = Join-Path $candidateAppRoot "resources\cua_node\bin\node.exe"
$copiedSourceHost = Join-Path $candidateAppRoot $detectedDesktopHost
$hostIcon = Join-Path $candidateAppRoot "resources\icon.ico"
$trayIcon = Join-Path $candidateAppRoot "resources\codex-tray.ico"
$appRootIcon = Join-Path $candidateAppRoot "icon.ico"
$hostIconPalette = Test-AntiCodexIconPalette -Path $hostIcon
$trayIconPalette = Test-AntiCodexIconPalette -Path $trayIcon
$appRootIconPalette = Test-AntiCodexIconPalette -Path $appRootIcon
$asarText = [Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes($asarPath))
$settingsDefinitionPattern = '/\*anticodex-local-settings-only\*/account:\{href:`about:blank`,icon:[\w$]+,message:(?<messages>[\w$]+)\.account\},securitySettings:\{href:`about:blank`,icon:[\w$]+,message:\k<messages>\.securitySettings\}'
$settingsAccountHiddenPattern = '/\*anticodex-hide-external-account\*/null'
$settingsModernSecurityItemPattern = '\{href:[\w$]+\.securitySettings\.href,id:`external:security-settings`,kind:`external`,label:[\w$]+\}'
$settingsSecurityDisabledPattern = 'securitySettingsEnabled:0\s*(?:,showMiniPetsLabel:[A-Za-z_$][\w$]*)?\s*\}'
$settingsDynamicWrapperPattern = '\{\.\.\.[\w$]+,securitySettingsEnabled:[A-Za-z_$][\w$]*\s*(?:,showMiniPetsLabel:[A-Za-z_$][\w$]*)?\s*\}'
if ([regex]::Matches($asarText, $settingsDefinitionPattern).Count -ne 1 -or
    ([regex]::Matches($asarText, $settingsAccountHiddenPattern).Count +
        [regex]::Matches($asarText, $settingsModernSecurityItemPattern).Count) -ne 1 -or
    [regex]::Matches($asarText, $settingsSecurityDisabledPattern).Count -ne 1 -or
    [regex]::Matches($asarText, $settingsDynamicWrapperPattern).Count -ne 0 -or
    [regex]::Matches($asarText, '\.securitySettings\.message').Count -lt 1 -or
    [regex]::Matches($asarText, '/\*anticodex-local-settings-only\*/\s*\}').Count -ne 0) {
    throw "Anti-Codex candidate Settings compatibility patch is invalid."
}
Test-AntiCodexCrashRecoveryPage -Text $asarText | Out-Null
$configWriteBridgePattern = '"batch-write-config-value":(?:async )?([\w$]+)=>this\.getRequestAppServerClient\(\1\.hostId\)\.sendAppServerRequest\([`"]config/batchWrite[`"],\1\)'
if ([regex]::Matches($asarText, $configWriteBridgePattern).Count -ne 1) {
    throw "Anti-Codex candidate native config write bridge count is invalid."
}
$codexTraySelectorCount = [regex]::Matches($asarText, 'codex-tray\.ico').Count
$alternateTraySelectorCount = [regex]::Matches($asarText, 'icon-agent\.ico|chatgpt-tray-(?:dark|light)\.ico').Count
$officialTrayGuidCount = [regex]::Matches($asarText, 'e5768d8b-6936-4f45-b1ad-4c5fb414cb35').Count
$antiCodexTrayGuidCount = [regex]::Matches($asarText, 'a91c0de5-7b42-4fa8-9d31-2e6c5b7048f3').Count
if ($codexTraySelectorCount -lt 4 -or $alternateTraySelectorCount -ne 0 -or
    $officialTrayGuidCount -ne 0 -or $antiCodexTrayGuidCount -ne 1) {
    throw "Anti-Codex candidate Windows tray icon/GUID identity is invalid."
}
$primaryDeferredRestoreRepaintPattern = 'trackPrimaryWindow\(([\w$]+)\)\{let ([\w$]+)=\(\)=>this\.primaryWindowLastActiveAtMs\.set\(\1,Date\.now\(\)\),([\w$]+)=\(\)=>\{try\{\1\.webContents\.invalidate\(\)\}catch\{\}\};this\.primaryWindows\.add\(\1\),\1\.isFocused\(\)\?\(this\.lastActivePrimaryWindow=\1,\2\(\)\):this\.lastActivePrimaryWindow\?\?=\1,this\.emitPrimaryWindowChangeIfNeeded\(\),\1\.on\(`focus`,\(\)=>\{this\.lastActivePrimaryWindow=\1,\2\(\),this\.emitPrimaryWindowChangeIfNeeded\(\)\}\),\1\.on\(`blur`,\2\),\1\.on\(`restore`,\(\)=>setImmediate\(\3\)\)\}'
$primaryFocusRestoreRepaintPattern = 'trackPrimaryWindow\(([\w$]+)\)\{let ([\w$]+)=\(\)=>this\.primaryWindowLastActiveAtMs\.set\(\1,Date\.now\(\)\),([\w$]+)=\(\)=>\{try\{\1\.webContents\.invalidate\(\)\}catch\{\}\};this\.primaryWindows\.add\(\1\),\1\.isFocused\(\)\?\(this\.lastActivePrimaryWindow=\1,\2\(\)\):this\.lastActivePrimaryWindow\?\?=\1,this\.emitPrimaryWindowChangeIfNeeded\(\),\1\.on\(`focus`,\(\)=>\{this\.lastActivePrimaryWindow=\1,\2\(\),this\.emitPrimaryWindowChangeIfNeeded\(\),\3\(\)\}\),\1\.on\(`blur`,\2\),\1\.on\(`restore`,\(\)=>setImmediate\(\3\)\)\}'
$legacyPrimaryRestoreRepaintPattern = 'trackPrimaryWindow\(([\w$]+)\)\{let ([\w$]+)=\(\)=>this\.primaryWindowLastActiveAtMs\.set\(\1,Date\.now\(\)\);this\.primaryWindows\.add\(\1\),\1\.isFocused\(\)\?\(this\.lastActivePrimaryWindow=\1,\2\(\)\):this\.lastActivePrimaryWindow\?\?=\1,this\.emitPrimaryWindowChangeIfNeeded\(\),\1\.on\(`focus`,\(\)=>\{this\.lastActivePrimaryWindow=\1,\2\(\),this\.emitPrimaryWindowChangeIfNeeded\(\)\}\),\1\.on\(`blur`,\2\),\1\.on\(`restore`,\(\)=>\1\.webContents\.invalidate\?\.\(\)\)\}'
$anyPrimaryWindowRepaintPattern = 'trackPrimaryWindow\(([\w$]+)\)\{.{0,700}?\1\.webContents\.invalidate(?:\?\.)?\(\)'
$officialPrimaryWindowTrackerPattern = 'trackPrimaryWindow\(([\w$]+)\)\{this\.primaryWindows\.add\(\1\),\1\.isFocused\(\)\?\(this\.lastActivePrimaryWindow=\1,this\.primaryWindowLastActiveAtMs\.set\(\1,Date\.now\(\)\)\):this\.lastActivePrimaryWindow\?\?=\1,this\.emitPrimaryWindowChangeIfNeeded\(\),\1\.on\(`focus`,\(\)=>\{this\.lastActivePrimaryWindow=\1,this\.primaryWindowLastActiveAtMs\.set\(\1,Date\.now\(\)\),this\.emitPrimaryWindowChangeIfNeeded\(\)\}\),\1\.on\(`blur`,\(\)=>\{this\.primaryWindowLastActiveAtMs\.set\(\1,Date\.now\(\)\)\}\)\}'
if ([regex]::Matches($asarText, $officialPrimaryWindowTrackerPattern).Count -ne 1) {
    throw "Anti-Codex candidate does not preserve the official primary-window tracker."
}
if ([regex]::Matches($asarText, $primaryDeferredRestoreRepaintPattern).Count -ne 0) {
    throw "Anti-Codex candidate still contains the revision-6 deferred restore repaint."
}
if ([regex]::Matches($asarText, $primaryFocusRestoreRepaintPattern).Count -ne 0) {
    throw "Anti-Codex candidate still contains the revision-2 focus repaint."
}
if ([regex]::Matches($asarText, $anyPrimaryWindowRepaintPattern).Count -ne 0) {
    throw "Anti-Codex candidate contains an unexpected primary-window repaint shape."
}
if ([regex]::Matches($asarText, $legacyPrimaryRestoreRepaintPattern).Count -ne 0) {
    throw "Anti-Codex candidate still contains the legacy synchronous primary-window restore repaint."
}
foreach ($managerMarker in @("__ANTICODEX_OPEN_MANAGER__", "\u7ba1\u7406")) {
    if (-not $asarText.Contains($managerMarker)) {
        throw "Anti-Codex candidate is missing the Chinese Manager entry: $managerMarker"
    }
}
$retiredFeaturePatchPatterns = @(
    '\?\.length<1\|\|[\w$]+\([\w$]+,[\w$]+\)',
    'var [\w$]+=async\(\)=>\(\{marketplaces:\[\]\}\);',
    'async listPlugins\([\w$]+\)\{return\{marketplaces:\[\],marketplaceLoadErrors:\[\]\}\}',
    '"list-plugins":[\w$]+\(([\w$]+)=>\1\.listPlugins\(\{\}\)\)',
    'case`error`:if\([\w$]+\.willRetry\)\{break\}else if\('
)
foreach ($pattern in $retiredFeaturePatchPatterns) {
    if ($asarText -match $pattern) {
        throw "Anti-Codex fixed shell candidate contains a retired feature patch: $pattern"
    }
}
if ($hostIconPalette.ok -ne $true) {
    throw "Anti-Codex candidate host icon is not the pink Codex cloud with white command marks."
}
if ($trayIconPalette.ok -ne $true) {
    throw "Anti-Codex candidate tray icon is not the pink Codex cloud with white command marks."
}
if ($appRootIconPalette.ok -ne $true) {
    throw "Anti-Codex candidate app-root icon is not the pink Codex cloud with white command marks."
}
$expectedHashes = [ordered]@{
    antiCodexExe = Get-AntiCodexSha256 -Path $antiCodex
    appAsar = Get-AntiCodexSha256 -Path $asarPath
    codexCli = Get-AntiCodexSha256 -Path $codex
    sandboxHelper = Get-AntiCodexSha256 -Path (Join-Path $candidateAppRoot "resources\codex-windows-sandbox-setup.exe")
    nodeRepl = Get-AntiCodexSha256 -Path (Join-Path $candidateAppRoot "resources\cua_node\bin\node_repl.exe")
    nodeRuntime = Get-AntiCodexSha256 -Path (Join-Path $candidateAppRoot "resources\cua_node\bin\node.exe")
    hostIcon = Get-AntiCodexSha256 -Path $hostIcon
    trayIcon = Get-AntiCodexSha256 -Path $trayIcon
    appRootIcon = Get-AntiCodexSha256 -Path $appRootIcon
}
foreach ($name in $expectedHashes.Keys) {
    if ([string]$manifest.files.$name -ne [string]$expectedHashes[$name]) {
        throw "Anti-Codex candidate marker hash mismatch: $name"
    }
}
if (-not $manifest.source -or -not $manifest.source.codexHost -or -not $manifest.source.codexCli) {
    throw "Anti-Codex candidate marker is missing source Codex fingerprints."
}
if ([string]$manifest.source.codexHost -ne [string](Get-AntiCodexSha256 -Path $copiedSourceHost)) {
    throw "Anti-Codex candidate source host fingerprint does not match the copied Codex host."
}
if ([string]$manifest.source.codexCli -ne [string]$expectedHashes.codexCli) {
    throw "Anti-Codex candidate source CLI fingerprint does not match the copied Codex CLI."
}
$asarIntegrityProperty = $manifest.PSObject.Properties["asarIntegrity"]
$asarIntegrity = if ($asarIntegrityProperty) { $asarIntegrityProperty.Value } else { $null }
if (-not $asarIntegrity -or
    [string]$asarIntegrity.originalHeaderHash -notmatch '^[a-fA-F0-9]{64}$' -or
    [string]$asarIntegrity.patchedHeaderHash -notmatch '^[a-fA-F0-9]{64}$') {
    throw "Anti-Codex candidate marker is missing Electron ASAR integrity provenance."
}
$asarIntegrityHostScript = Join-Path $PSScriptRoot "electron-asar-integrity-host.mjs"
if (-not (Test-Path -LiteralPath $asarIntegrityHostScript -PathType Leaf)) {
    throw "Anti-Codex candidate Electron ASAR integrity verifier is missing."
}
$asarIntegrityOutput = @(& $nodeRuntime $asarIntegrityHostScript --verify $copiedSourceHost $antiCodex ([string]$asarIntegrity.originalHeaderHash) ([string]$asarIntegrity.patchedHeaderHash) 2>&1)
if ($LASTEXITCODE -ne 0) {
    throw "Anti-Codex candidate isolated launcher ASAR integrity patch is invalid."
}
$asarIntegrityResult = try { (($asarIntegrityOutput -join [Environment]::NewLine) | ConvertFrom-Json) } catch { throw "Anti-Codex candidate ASAR integrity verification receipt is invalid." }
if ($asarIntegrityResult.ok -ne $true -or [bool]$asarIntegrityResult.patched -ne [bool]$asarIntegrity.executablePatched) {
    throw "Anti-Codex candidate ASAR integrity verification does not match its marker."
}

$asar = Get-Item -LiteralPath $asarPath
if ($asar.Length -lt 1MB) {
    throw "Anti-Codex candidate app package is invalid."
}

$asarIntegrityScript = Join-Path $PSScriptRoot "verify-anticodex-asar-integrity.mjs"
& $nodeRuntime $asarIntegrityScript $asarPath
if ($LASTEXITCODE -ne 0) {
    throw "Anti-Codex candidate ASAR integrity validation failed."
}

$versionOutput = @(& $codex --version 2>&1)
if ($LASTEXITCODE -ne 0 -or -not ($versionOutput -join "").Trim()) {
    throw "Anti-Codex candidate bundled Codex CLI did not start."
}

Write-Host "Anti-Codex candidate validated: $($versionOutput -join ' ')"
