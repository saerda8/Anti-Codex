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

$bootstrapToolchain = $env:ANTICODEX_CARGO_XWIN_BOOTSTRAP -eq "1" -and $CargoArguments[0] -ceq "xwin"
$dockerArgs = @(
    "run",
    "--rm",
    "--name", $ContainerName,
    "--label", "com.anticodex.ephemeral-build=true",
    "--env", "CARGO_BUILD_JOBS=1",
    "--env", "CARGO_PROFILE_TEST_DEBUG=0",
    "--env", "CARGO_TARGET_DIR=/build-cache",
    "--mount", "type=bind,source=$resolvedWorktree,destination=/work",
    "--volume", "anticodex-cargo-xwin-cache:/root/.cache/cargo-xwin",
    "--volume", "anticodex-cargo-git:/usr/local/cargo/git",
    "--volume", "anticodex-cargo-registry:/usr/local/cargo/registry",
    "--volume", "anticodex-cargo-target:/build-cache",
    "--workdir", "/work"
)
if ($bootstrapToolchain -or ($CargoArguments.Count -ge 2 -and $CargoArguments[0] -ceq "xwin" -and $CargoArguments[1] -ceq "build" -and $CargoArguments -contains "codex-plus-launcher")) {
    $cargoArgsText = ($CargoArguments | ForEach-Object {
        "'" + ([string]$_).Replace("'", "'\\''") + "'"
    }) -join " "
    $tool = if ($CargoArguments[0] -ceq "xwin") { "cargo-xwin" } else { "cargo" }
    $bootstrapCommand = "export PATH=/usr/local/cargo/bin:`$PATH && $tool $cargoArgsText"
    if ($bootstrapToolchain) {
        $bootstrapCommand = "apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq clang llvm lld && ln -sf `$(command -v clang-19 || command -v clang) /usr/local/bin/clang-cl && ln -sf `$(command -v llvm-lib-19 || command -v llvm-lib || command -v llvm-ar) /usr/local/bin/llvm-lib && export PATH=/usr/local/cargo/bin:`$PATH CC_x86_64_pc_windows_msvc=clang-cl AR_x86_64_pc_windows_msvc=llvm-lib && $bootstrapCommand"
    }
    if ($CargoArguments.Count -ge 2 -and $CargoArguments[1] -ceq "build" -and $CargoArguments -contains "codex-plus-launcher") {
        $bootstrapCommand += " && mkdir -p /work/target/x86_64-pc-windows-msvc/release && cp /build-cache/x86_64-pc-windows-msvc/release/codex-plus-plus.exe /work/target/x86_64-pc-windows-msvc/release/codex-plus-plus.exe"
    }
    $dockerArgs += @(
        "--entrypoint", "/bin/sh",
        $image,
        "-lc",
        $bootstrapCommand
    )
} else {
    $dockerArgs += @($image, "cargo") + $CargoArguments
}

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
