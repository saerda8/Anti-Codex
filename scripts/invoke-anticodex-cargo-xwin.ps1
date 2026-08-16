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

if ($CargoArguments[0] -ceq "fmt") {
    Push-Location $resolvedWorktree
    try {
        & cargo @CargoArguments
        if ($LASTEXITCODE -ne 0) {
            throw "cargo fmt exited with code $LASTEXITCODE"
        }
    }
    finally {
        Pop-Location
    }
    return
}

$existingContainer = & docker container ls --all --quiet --filter "name=^/$ContainerName`$"
if ($LASTEXITCODE -ne 0) {
    throw "Failed to inspect Docker container state for $ContainerName"
}
if ($existingContainer) {
    throw "Refusing to reuse or remove an existing container: $ContainerName"
}

$dockerArgs = @(
    "run",
    "--rm",
    "--name", $ContainerName,
    "--label", "com.anticodex.ephemeral-build=true",
    "--env", "CARGO_BUILD_JOBS=2",
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
    $existingContainer = & docker container ls --all --quiet --filter "name=^/$ContainerName`$"
    if ($LASTEXITCODE -eq 0 -and $existingContainer) {
        & docker rm -f $ContainerName | Out-Null
    }
}
