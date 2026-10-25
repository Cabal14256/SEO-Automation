[CmdletBinding()]
param(
    [Parameter(Position=0)][ValidateSet('db-start','api-start','worker-start','status','stop')][string]$Action,
    [Parameter(Mandatory=$true)][string]$ConfigPath
)
$ErrorActionPreference = 'Stop'
$config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($config.restoreOnly -ne $true -or $config.workerEnabled -ne $false -or $config.postgresPort -in @(5432,55432,55433) -or $config.database -notmatch '^scm_restore_[a-z0-9_]+$') { throw 'Only an explicitly isolated restore configuration is supported.' }
$root = [IO.Path]::GetFullPath($config.trialRoot).TrimEnd('\')
foreach ($path in @($config.envPath,$config.postgresDataDir,$config.runtimeDir,$config.releasePath)) {
    if (![IO.Path]::GetFullPath($path).StartsWith($root+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Recovery paths must stay inside the isolated restore directory.' }
}
$environment = Get-Content -LiteralPath $config.envPath -Raw -Encoding UTF8
if ($environment -notmatch '(?m)^LINGXING_REQUESTS_ENABLED="?false"?\s*$') { throw 'Recovery external requests must remain disabled.' }
function Invoke-PgCtl([string[]]$Arguments) {
    $stamp=[Guid]::NewGuid().ToString('N')
    $out=Join-Path $config.runtimeDir "pgctl-$stamp.out.log"
    $err=Join-Path $config.runtimeDir "pgctl-$stamp.err.log"
    $quoted=($Arguments | ForEach-Object { '"'+$_.Replace('"','\"')+'"' }) -join ' '
    $process=Start-Process -FilePath (Join-Path $config.postgresBin 'pg_ctl.exe') -ArgumentList $quoted -WindowStyle Hidden -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
    $null=$process.Handle
    if(!$process.WaitForExit(35000)) { throw 'Recovery PostgreSQL command timed out.' }
    return $process.ExitCode
}
function Managed-Process([string]$Name) {
    $file=Join-Path $config.runtimeDir "$Name.pid.json"
    if(!(Test-Path -LiteralPath $file)) { return $null }
    $record=Get-Content -LiteralPath $file -Raw -Encoding UTF8 | ConvertFrom-Json
    $process=Get-Process -Id $record.processId -ErrorAction SilentlyContinue
    if(!$process -or $process.StartTime.ToUniversalTime().Ticks -ne ([datetime]$record.startedAt).ToUniversalTime().Ticks) { return $null }
    $actual=Get-CimInstance Win32_Process -Filter "ProcessId=$($process.Id)"
    if(!$actual.CommandLine.Contains((Join-Path $config.releasePath "apps/server/dist/$Name.js"))) { throw 'Recovery process identity changed.' }
    return $process
}
function Start-App([string]$Name) {
    if(Managed-Process $Name) { return }
    $prior=$env:DOTENV_CONFIG_PATH
    $priorOverride=$env:DOTENV_CONFIG_OVERRIDE
    $priorOutbound=$env:LINGXING_REQUESTS_ENABLED
    try {
        $env:DOTENV_CONFIG_PATH=$config.envPath
        $env:DOTENV_CONFIG_OVERRIDE='true'
        $env:LINGXING_REQUESTS_ENABLED='false'
        $process=Start-Process -FilePath (Join-Path $config.releasePath 'runtime/node.exe') -ArgumentList ('"'+(Join-Path $config.releasePath "apps/server/dist/$Name.js")+'"') -WorkingDirectory (Join-Path $config.releasePath 'apps/server') -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $config.runtimeDir "$Name.out.log") -RedirectStandardError (Join-Path $config.runtimeDir "$Name.err.log")
    } finally { $env:DOTENV_CONFIG_PATH=$prior; $env:DOTENV_CONFIG_OVERRIDE=$priorOverride; $env:LINGXING_REQUESTS_ENABLED=$priorOutbound }
    Start-Sleep -Milliseconds 500
    if($process.HasExited) { throw 'Recovery process failed; inspect its controlled log.' }
    $record=@{processId=$process.Id;startedAt=$process.StartTime.ToUniversalTime().ToString('o')}
    [IO.File]::WriteAllText((Join-Path $config.runtimeDir "$Name.pid.json"),($record|ConvertTo-Json),(New-Object Text.UTF8Encoding $false))
    if($Name -in @('api','worker')) {
        $deadline=[DateTime]::UtcNow.AddSeconds(30)
        $ready=$false
        do {
            try {
                $health=Invoke-RestMethod -Uri "http://127.0.0.1:$($config.apiPort)/api/v1/health" -TimeoutSec 2
                if($Name -eq 'api' -and $health.database -eq 'ok') { $ready=$true; break }
                if($Name -eq 'worker' -and $health.database -eq 'ok' -and $health.worker -eq 'ok') {
                    $previousPassword=$env:PGPASSWORD
                    try {
                        $env:PGPASSWORD=$config.appPassword
                        $fresh=& (Join-Path $config.postgresBin 'psql.exe') -X -w -h 127.0.0.1 -p $config.postgresPort -U scm_app -d $config.database -t -A -c "select count(*) from worker_heartbeat where process_id=$($process.Id);"
                        if($LASTEXITCODE -eq 0 -and [int]$fresh -eq 1) { $ready=$true; break }
                    } finally { $env:PGPASSWORD=$previousPassword }
                }
            } catch { }
            Start-Sleep -Milliseconds 300
        } while([DateTime]::UtcNow -lt $deadline)
        if(!$ready) { throw 'Recovery process did not become ready.' }
    }
    Write-Output "Recovery $Name started."
}
switch($Action) {
    'db-start' {
        $status=Invoke-PgCtl @('status','-D',$config.postgresDataDir)
        if($status -eq 3) {
            if((Invoke-PgCtl @('start','-D',$config.postgresDataDir,'-l',(Join-Path $config.runtimeDir 'postgres.log'),'-w')) -ne 0) { throw 'Recovery database failed to start.' }
        } elseif($status -ne 0) { throw 'Recovery database status could not be checked.' }
        Write-Output 'Isolated recovery database is running.'
    }
    'api-start' { Start-App 'api' }
    'worker-start' { Start-App 'worker' }
    'status' {
        foreach($name in @('api','worker')) { [pscustomobject]@{name=$name;running=[bool](Managed-Process $name)} }
        [pscustomobject]@{name='postgres';running=((Invoke-PgCtl @('status','-D',$config.postgresDataDir)) -eq 0)}
    }
    'stop' {
        foreach($name in @('worker','api')) { $process=Managed-Process $name; if($process) { Stop-Process -Id $process.Id -Force; $process.WaitForExit(10000)|Out-Null } }
        $status=Invoke-PgCtl @('status','-D',$config.postgresDataDir)
        if($status -eq 0 -and (Invoke-PgCtl @('stop','-D',$config.postgresDataDir,'-m','fast','-w')) -ne 0) { throw 'Recovery database failed to stop.' }
        Write-Output 'Only the isolated recovery processes were stopped.'
    }
}
