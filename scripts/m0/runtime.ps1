[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('doctor', 'status', 'start', 'stop', 'app-start', 'app-stop', 'app-restart', 'db-start', 'db-stop')]
    [string]$Action = 'status',
    [string]$ConfigPath
)

$ErrorActionPreference = 'Stop'
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
. (Join-Path $PSScriptRoot '../shared/path-policy.ps1')
if (-not $ConfigPath) { $ConfigPath = Join-Path $repository '.local/m0-runtime.json' }
$ConfigPath = [IO.Path]::GetFullPath($ConfigPath)

function Resolve-Executable([string]$Name, [string[]]$Candidates) {
    $command = Get-Command $Name -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    foreach ($candidate in $Candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) { return $candidate }
    }
    throw "$Name was not found. Install the documented toolchain before continuing."
}

function Assert-ExternalPath([string]$Path, [string]$Name) {
    return Resolve-ScmRuntimePath -Repository $repository -Path $Path -Role development -NodeExecutable $node
}

function Read-RuntimeConfig {
    if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
        throw "Runtime configuration is missing. Copy scripts/m0/runtime.example.json to .local/m0-runtime.json and set the existing development cluster paths."
    }
    try { $value = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json }
    catch { throw 'Runtime configuration is invalid JSON.' }
    if (-not $value.PSObject.Properties['postgresDataDir'] -and $value.PSObject.Properties['postgresDir']) {
        $value | Add-Member NoteProperty postgresDataDir $value.postgresDir
    }
    if (-not $value.PSObject.Properties['runtimeDir']) {
        $value | Add-Member NoteProperty runtimeDir (Join-Path (Split-Path $ConfigPath -Parent) 'runtime')
    }
    if (-not $value.PSObject.Properties['healthUrl']) {
        $value | Add-Member NoteProperty healthUrl 'http://localhost:3001/api/v1/health'
    }
    foreach ($key in @('postgresBin', 'postgresDataDir', 'runtimeDir', 'healthUrl', 'postgresPort')) {
        if (-not $value.PSObject.Properties[$key] -or -not $value.$key) { throw "Runtime configuration is missing $key." }
    }
    $value.postgresDataDir = Assert-ExternalPath $value.postgresDataDir 'postgresDataDir'
    $value.runtimeDir = Assert-ExternalPath $value.runtimeDir 'runtimeDir'
    if ([int]$value.postgresPort -lt 1 -or [int]$value.postgresPort -gt 65535) { throw 'postgresPort must be a valid TCP port.' }
    $healthUri = [uri]$value.healthUrl
    if (-not $healthUri.IsLoopback -or $healthUri.Scheme -notin @('http', 'https') -or $healthUri.UserInfo) {
        throw 'healthUrl must be a local HTTP URL without credentials.'
    }
    return $value
}

function Invoke-PgCtl([string[]]$Arguments) {
    $pgCtl = Join-Path $script:runtime.postgresBin 'pg_ctl.exe'
    if (-not (Test-Path -LiteralPath $pgCtl -PathType Leaf)) { throw 'PostgreSQL pg_ctl.exe was not found at postgresBin.' }
    New-Item -ItemType Directory -Path $script:runtime.runtimeDir -Force | Out-Null
    $stamp = [Guid]::NewGuid().ToString('N')
    $stdout = Join-Path $script:runtime.runtimeDir "pgctl-$stamp.stdout.log"
    $stderr = Join-Path $script:runtime.runtimeDir "pgctl-$stamp.stderr.log"
    $quoted = ($Arguments | ForEach-Object { '"' + $_.Replace('"', '\"') + '"' }) -join ' '
    # A PowerShell native pipeline can wait forever for handles inherited by the
    # server. Wait only for pg_ctl itself, with output redirected to local files.
    $process = Start-Process -FilePath $pgCtl -ArgumentList $quoted -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    # Windows PowerShell 5.1 otherwise releases the process handle before ExitCode
    # is read when Start-Process is used without its tree-waiting -Wait option.
    $null = $process.Handle
    if (-not $process.WaitForExit(35000)) { throw 'PostgreSQL control command timed out. Inspect the controlled local log.' }
    foreach ($output in @($stdout, $stderr)) {
        if (Test-Path -LiteralPath $output) { Get-Content -LiteralPath $output | ForEach-Object { Write-Host $_ } }
    }
    return $process.ExitCode
}

function Get-ManagedProcess([string]$Name) {
    $recordPath = Join-Path $script:runtime.runtimeDir "$Name.pid.json"
    if (-not (Test-Path -LiteralPath $recordPath -PathType Leaf)) { return $null }
    try {
        $record = Get-Content -LiteralPath $recordPath -Raw | ConvertFrom-Json
        $process = Get-Process -Id ([int]$record.processId) -ErrorAction SilentlyContinue
        if (-not $process) { return $null }
        # PowerShell 7 parses ISO JSON timestamps into DateTime; 5.1 keeps strings.
        $recordStart = ([datetime]$record.startedAt).ToUniversalTime()
        if ($process.StartTime.ToUniversalTime().Ticks -ne $recordStart.Ticks) { return $null }
        $details = Get-CimInstance Win32_Process -Filter "ProcessId = $($process.Id)"
        $expectedScript = Join-Path $repository "apps/server/dist/$Name.js"
        if (-not $details.CommandLine -or -not $details.CommandLine.Contains($expectedScript)) { return $null }
        return $process
    } catch { return $null }
}

function Start-Database {
    if (-not (Test-Path -LiteralPath (Join-Path $script:runtime.postgresDataDir 'PG_VERSION') -PathType Leaf)) {
        throw 'The configured PostgreSQL cluster does not exist. Provision the independent development database first.'
    }
    $statusCode = Invoke-PgCtl @('status', '-D', $script:runtime.postgresDataDir)
    if ($statusCode -eq 0) { return }
    if ($statusCode -ne 3) { throw 'Unable to inspect the configured PostgreSQL cluster.' }
    New-Item -ItemType Directory -Path $script:runtime.runtimeDir -Force | Out-Null
    $pgLog = Join-Path $script:runtime.runtimeDir 'postgres.log'
    $startCode = Invoke-PgCtl @('start', '-D', $script:runtime.postgresDataDir, '-l', $pgLog,
        '-o', "-h 127.0.0.1 -p $($script:runtime.postgresPort)", '-w', '-t', '30')
    if ($startCode -ne 0) { throw 'PostgreSQL did not start. Inspect the controlled local PostgreSQL log.' }
}

function Stop-Database {
    $statusCode = Invoke-PgCtl @('status', '-D', $script:runtime.postgresDataDir)
    if ($statusCode -eq 3) { return }
    if ($statusCode -ne 0) { throw 'Unable to inspect the configured PostgreSQL cluster.' }
    $stopCode = Invoke-PgCtl @('stop', '-D', $script:runtime.postgresDataDir, '-m', 'fast', '-w', '-t', '30')
    if ($stopCode -ne 0) { throw 'PostgreSQL did not stop cleanly.' }
}

function Start-ApplicationProcess([string]$Name) {
    if (Get-ManagedProcess $Name) { Write-Output "$Name is already running."; return }
    $entryPoint = Join-Path $repository "apps/server/dist/$Name.js"
    if (-not (Test-Path -LiteralPath $entryPoint -PathType Leaf)) { throw "Build output for $Name is missing. Run corepack pnpm build first." }
    if (-not (Test-Path -LiteralPath (Join-Path $repository 'apps/server/.env') -PathType Leaf)) { throw 'apps/server/.env is missing.' }
    New-Item -ItemType Directory -Path $script:runtime.runtimeDir -Force | Out-Null
    $stamp = [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss-fff')
    $stdout = Join-Path $script:runtime.runtimeDir "$Name-$stamp.stdout.log"
    $stderr = Join-Path $script:runtime.runtimeDir "$Name-$stamp.stderr.log"
    $previousTimeZone = $env:TZ
    try {
        $env:TZ = 'Asia/Shanghai'
        $process = Start-Process -FilePath $script:node -ArgumentList @('"' + $entryPoint + '"') -WorkingDirectory (Join-Path $repository 'apps/server') -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    } finally { $env:TZ = $previousTimeZone }
    Start-Sleep -Milliseconds 300
    if ($process.HasExited) { throw "$Name exited during startup. Inspect its controlled local log." }
    [ordered]@{
        processId = $process.Id
        startedAt = $process.StartTime.ToUniversalTime().ToString('o')
        stdout = $stdout
        stderr = $stderr
    } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $script:runtime.runtimeDir "$Name.pid.json") -Encoding UTF8
    Write-Output "$Name started (PID $($process.Id))."
}

function Stop-ApplicationProcess([string]$Name) {
    $process = Get-ManagedProcess $Name
    if (-not $process) { Write-Output "$Name is not running under this script."; return }
    # Windows terminates these development processes. PostgreSQL rolls back any open
    # transaction; durable jobs are recovered by pg-boss when the worker restarts.
    Stop-Process -Id $process.Id -Force
    $process.WaitForExit(10000) | Out-Null
    Remove-Item -LiteralPath (Join-Path $script:runtime.runtimeDir "$Name.pid.json") -Force
    Write-Output "$Name stopped."
}

function Show-Health {
    try {
        $response = Invoke-WebRequest -Uri $script:runtime.healthUrl -UseBasicParsing -TimeoutSec 8
        $body = $response.Content | ConvertFrom-Json
        Write-Output "API health: HTTP $($response.StatusCode); database=$($body.database); worker=$($body.worker)"
    } catch {
        if ($_.Exception.Response) { Write-Output "API health: HTTP $([int]$_.Exception.Response.StatusCode) (unhealthy)." }
        else { Write-Output 'API health: unreachable.' }
    }
}

function Wait-Application {
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    do {
        if (-not (Get-ManagedProcess 'api') -or -not (Get-ManagedProcess 'worker')) {
            throw 'A managed application process exited. Inspect its controlled local log.'
        }
        try {
            $response = Invoke-WebRequest -Uri $script:runtime.healthUrl -UseBasicParsing -TimeoutSec 5
            $body = $response.Content | ConvertFrom-Json
            if ($response.StatusCode -eq 200 -and $body.database -eq 'ok' -and $body.worker -eq 'ok') {
                Show-Health
                return
            }
        } catch { }
        Start-Sleep -Milliseconds 300
    } while ([DateTime]::UtcNow -lt $deadline)
    throw 'Application did not become healthy within 30 seconds. Inspect its controlled local logs.'
}

try {
    $node = Resolve-Executable 'node' @(
        (Join-Path $env:ProgramFiles 'nodejs/node.exe'),
        (Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe')
    )
    $nodeVersion = & $node --version
    if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v24\.' -or [version]$nodeVersion.TrimStart('v') -lt [version]'24.22.1') { throw 'Node.js >=24.22.1 <25 is required.' }
    $runtime = Read-RuntimeConfig
    switch ($Action) {
        'doctor' {
            Write-Output "Node: $nodeVersion"
            $corepack = Resolve-Executable 'corepack' @((Join-Path (Split-Path $node -Parent) 'corepack.cmd'))
            Push-Location -LiteralPath $repository
            try {
                $pnpmVersion = & $corepack pnpm --version
                if ($LASTEXITCODE -ne 0) { throw 'Corepack could not resolve the locked pnpm version.' }
                $expected = (Get-Content -LiteralPath (Join-Path $repository 'package.json') -Raw | ConvertFrom-Json).packageManager.Split('@')[-1]
                if ($pnpmVersion -ne $expected) { throw 'pnpm differs from package.json packageManager.' }
                Write-Output "pnpm: $pnpmVersion"
            } finally { Pop-Location }
            $postgres = Join-Path $runtime.postgresBin 'postgres.exe'
            if (-not (Test-Path -LiteralPath $postgres -PathType Leaf)) { throw 'PostgreSQL was not found at postgresBin.' }
            & $postgres --version
            if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL version check failed.' }
            if (-not (Test-Path -LiteralPath (Join-Path $repository 'apps/server/.env') -PathType Leaf)) { throw 'apps/server/.env is missing.' }
            Write-Output 'Runtime paths passed the private-directory policy; local application configuration exists.'
        }
        'db-start' { Start-Database }
        'db-stop' { Stop-Database }
        'app-start' { Start-ApplicationProcess 'api'; Start-ApplicationProcess 'worker'; Wait-Application }
        'app-stop' { Stop-ApplicationProcess 'worker'; Stop-ApplicationProcess 'api' }
        'app-restart' {
            Stop-ApplicationProcess 'worker'; Stop-ApplicationProcess 'api'
            Start-ApplicationProcess 'api'; Start-ApplicationProcess 'worker'; Wait-Application
        }
        'start' { Start-Database; Start-ApplicationProcess 'api'; Start-ApplicationProcess 'worker'; Wait-Application }
        'stop' { Stop-ApplicationProcess 'worker'; Stop-ApplicationProcess 'api'; Stop-Database }
        'status' {
            $databaseCode = Invoke-PgCtl @('status', '-D', $runtime.postgresDataDir)
            if ($databaseCode -eq 0) { Write-Output 'PostgreSQL: running.' }
            elseif ($databaseCode -eq 3) { Write-Output 'PostgreSQL: stopped.' }
            else { Write-Output 'PostgreSQL: status unavailable.' }
            foreach ($name in @('api', 'worker')) {
                $process = Get-ManagedProcess $name
                if ($process) { Write-Output "$name`: running (PID $($process.Id))." }
                else { Write-Output "$name`: not managed or stopped." }
            }
            Show-Health
        }
    }
} catch {
    # Only script-authored errors are exposed here. Configuration file contents,
    # environment variables, database URLs and process command lines are never printed.
    $message = $_.Exception.Message
    if ($_.InvocationInfo.ScriptName -ne $PSCommandPath) { $message = 'Runtime command failed. Inspect the controlled local configuration and logs.' }
    Write-Error $message
    exit 1
}
