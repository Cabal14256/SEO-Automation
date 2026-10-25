# Use the same canonical-path policy as release and recovery tooling.
function Resolve-ScmNodeExecutable([string]$NodeExecutable) {
    if ($NodeExecutable) {
        if (-not (Test-Path -LiteralPath $NodeExecutable -PathType Leaf)) { throw 'The selected Node executable is missing.' }
        return $NodeExecutable
    }
    $command = Get-Command node -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    foreach ($candidate in @(
        (Join-Path $env:ProgramFiles 'nodejs/node.exe'),
        (Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe')
    )) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    }
    throw 'Node.js was not found for runtime path validation.'
}

function Resolve-ScmRuntimePath {
    param([string]$Repository, [string]$Path, [ValidateSet('development','data','trial','release','restore')][string]$Role = 'development', [string]$NodeExecutable)
    $helper = Join-Path $PSScriptRoot 'path-policy.mjs'
    $nodePath = Resolve-ScmNodeExecutable $NodeExecutable
    $output = & $nodePath $helper runtime $Repository $Path $Role
    if ($LASTEXITCODE -ne 0) { throw 'Runtime path failed the private-directory policy.' }
    return [string]$output
}

function Resolve-ScmPhysicalPath([string]$Path, [string]$NodeExecutable) {
    $nodePath = Resolve-ScmNodeExecutable $NodeExecutable
    $output = & $nodePath (Join-Path $PSScriptRoot 'path-policy.mjs') physical $Path
    if ($LASTEXITCODE -ne 0) { throw 'Runtime path could not be resolved safely.' }
    return [string]$output
}
