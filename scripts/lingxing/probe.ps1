# Resolve Node without changing the user's PATH or installing a runtime.
$ErrorActionPreference = 'Stop'
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
$nodeExecutable = if ($nodeCommand) { $nodeCommand.Source } else { $null }
if (-not $nodeExecutable) {
    $candidates = @(
        (Join-Path $env:LOCALAPPDATA 'Programs/nodejs/node.exe'),
        (Join-Path $env:ProgramFiles 'nodejs/node.exe'),
        (Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe')
    )
    $nodeExecutable = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
}
if (-not $nodeExecutable) { throw 'Node.js was not found. Install Node.js 24 and retry.' }
$version = & $nodeExecutable --version
if ($LASTEXITCODE -ne 0 -or $version -notmatch '^v24\.' -or [version]$version.TrimStart('v') -lt [version]'24.22.1') { throw "Node.js >=24.22.1 <25 is required; found $version at $nodeExecutable" }
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
Push-Location -LiteralPath $repository
try {
    & $nodeExecutable (Join-Path $PSScriptRoot 'probe.mjs') @args
    $probeExitCode = $LASTEXITCODE
} finally {
    Pop-Location
}
exit $probeExitCode
