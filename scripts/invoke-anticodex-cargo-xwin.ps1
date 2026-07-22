[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Worktree,

    [Parameter(Mandatory = $true, ValueFromRemainingArguments = $true)]
    [string[]]$CargoArguments,

    [string]$ContainerName = ("anticodex-cpp-build-" + [Guid]::NewGuid().ToString("N").Substring(0, 12))
)

$ErrorActionPreference = "Stop"
$image = "messense/cargo-xwin:0.23.0"
$namePattern = '^anticodex-cpp-build-[a-z0-9][a-z0-9_.-]{0,50}$'
if ($ContainerName -cnotmatch $namePattern) {
    throw "ContainerName must match $namePattern"
}
if (-not $CargoArguments -or $CargoArguments.Count -eq 0) {
    throw "At least one Cargo argument is required."
}

$resolvedWorktree = (Resolve-Path -LiteralPath $Worktree -ErrorAction Stop).Path
if (-not (Test-Path -LiteralPath $resolvedWorktree -PathType Container)) {
    throw "Worktree is not a directory: $resolvedWorktree"
}

& docker container inspect $ContainerName *> $null
if ($LASTEXITCODE -eq 0) {
    throw "Refusing to reuse or remove an existing container: $ContainerName"
}

$dockerArgs = @(
    "run",
    "--rm",
    "--name", $ContainerName,
    "--label", "com.anticodex.ephemeral-build=true",
    "--mount", "type=bind,source=$resolvedWorktree,destination=/work",
    "--volume", "anticodex-cargo-xwin-cache:/root/.cache/cargo-xwin",
    "--volume", "anticodex-cargo-git:/usr/local/cargo/git",
    "--volume", "anticodex-cargo-registry:/usr/local/cargo/registry",
    "--workdir", "/work",
    $image,
    "cargo"
) + $CargoArguments

try {
    & docker @dockerArgs
    $dockerExitCode = $LASTEXITCODE
    if ($dockerExitCode -ne 0) {
        throw "cargo-xwin container exited with code $dockerExitCode"
    }
}
finally {
    & docker container inspect $ContainerName *> $null
    if ($LASTEXITCODE -eq 0) {
        & docker rm -f $ContainerName | Out-Null
    }
}
