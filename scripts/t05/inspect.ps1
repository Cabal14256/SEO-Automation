[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string[]]$Source,
    [Parameter(Mandatory = $true)][string]$Out,
    [ValidateRange(1, 1048576)][int]$HeaderRow = 1,
    [string]$Encoding = 'utf-8-sig',
    [string]$PythonPath
)
$ErrorActionPreference = 'Stop'
if (-not $PythonPath) {
    $bundled = Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe'
    if (Test-Path -LiteralPath $bundled -PathType Leaf) { $PythonPath = $bundled }
    else {
        $python = Get-Command python -ErrorAction SilentlyContinue
        if ($python -and $python.Source -notmatch 'WindowsApps') { $PythonPath = $python.Source }
    }
}
if (-not $PythonPath -or -not (Test-Path -LiteralPath $PythonPath -PathType Leaf)) {
    throw 'Python 3 is required for this offline diagnostic. Supply -PythonPath with the installed executable.'
}
$arguments = @((Join-Path $PSScriptRoot 'inspect_inputs.py'), '--out', $Out, '--header-row', $HeaderRow, '--encoding', $Encoding)
foreach ($path in $Source) { $arguments += @('--source', $path) }
& $PythonPath @arguments
exit $LASTEXITCODE
