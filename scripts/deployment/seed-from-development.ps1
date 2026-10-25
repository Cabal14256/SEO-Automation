[CmdletBinding()]
param(
    [string]$TrialConfig = (Join-Path $PSScriptRoot '../../.local/trial/runtime.json'),
    [string]$SourceConfig = (Join-Path $PSScriptRoot '../../.local/development/runtime.json')
)
$ErrorActionPreference = 'Stop'
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$target = Get-Content -LiteralPath $TrialConfig -Raw -Encoding UTF8 | ConvertFrom-Json
$source = Get-Content -LiteralPath $SourceConfig -Raw -Encoding UTF8 | ConvertFrom-Json
if ($target.postgresPort -eq $source.postgresPort -or $target.database -eq $source.database -or $target.dataDir -eq (Join-Path (Split-Path $SourceConfig -Parent) 'data')) { throw 'The trial must use a separate cluster, database and data directory.' }
if ((Get-Service -Name $target.services.api -ErrorAction SilentlyContinue).Status -eq 'Running' -or
    (Get-Service -Name $target.services.worker -ErrorAction SilentlyContinue).Status -eq 'Running') { throw 'Stop trial API and Worker before seeding.' }
$priorPassword = $env:PGPASSWORD
$dump = Join-Path $target.runtimeDir 'development-seed.dump'
$apiWasRunning = $false
$workerWasRunning = $false
foreach ($name in @('api', 'worker')) {
    $pidPath = Join-Path (Split-Path $SourceConfig -Parent) "runtime/$name.pid.json"
    if (Test-Path -LiteralPath $pidPath) {
        $record = Get-Content -LiteralPath $pidPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $process = Get-Process -Id $record.processId -ErrorAction SilentlyContinue
        if ($process -and $process.StartTime.ToUniversalTime().Ticks -eq ([datetime]$record.startedAt).ToUniversalTime().Ticks) {
            if ($name -eq 'api') { $apiWasRunning = $true } else { $workerWasRunning = $true }
        }
    }
}
if ($apiWasRunning -ne $workerWasRunning) { throw 'Development API/Worker state is mixed; reconcile it before taking a consistent snapshot.' }
try {
    $env:PGPASSWORD = $target.appPassword
    $tables = & (Join-Path $target.postgresBin 'psql.exe') -X -w -h 127.0.0.1 -p $target.postgresPort -U $target.appUser -d $target.database -t -A -c "SELECT count(*) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema');"
    if ($LASTEXITCODE -ne 0 -or [int]$tables -ne 0) { throw 'Target database is not empty; it will not be overwritten.' }
    if (@(Get-ChildItem -LiteralPath $target.dataDir -Force).Count) { throw 'Target data directory must be empty.' }
    if ($apiWasRunning) { & (Join-Path $repository 'scripts/m0/runtime.ps1') app-stop; if (!$?) { throw 'Development application could not be stopped.' } }
    $env:PGPASSWORD = $source.appPassword
    & (Join-Path $source.postgresBin 'pg_dump.exe') -h 127.0.0.1 -p $source.postgresPort -U $source.appUser -d $source.database --no-owner --no-acl -Fc -f $dump
    if ($LASTEXITCODE -ne 0) { throw 'Development snapshot failed.' }
    $sourceData = Join-Path (Split-Path $SourceConfig -Parent) 'data'
    & robocopy $sourceData $target.dataDir /E /COPY:DAT /DCOPY:DAT /R:1 /W:1 /NFL /NDL /NP /NJH /NJS | Out-Null
    if ($LASTEXITCODE -gt 7) { throw 'Data snapshot failed.' }
    $env:PGPASSWORD = $target.appPassword
    & (Join-Path $target.postgresBin 'pg_restore.exe') -w -h 127.0.0.1 -p $target.postgresPort -U $target.appUser -d $target.database --no-owner --no-acl --exit-on-error --single-transaction $dump
    if ($LASTEXITCODE -ne 0) { throw 'Trial snapshot restore failed.' }
    $report = [ordered]@{ copiedAt=[DateTime]::UtcNow.ToString('o'); sourcePort=$source.postgresPort; targetPort=$target.postgresPort; sourcePreserved=$true; outboundEnabled=$false; dataset='existing controlled development records; not business acceptance' }
    [IO.File]::WriteAllText((Join-Path $target.trialRoot 'evidence/initial-snapshot.json'), ($report | ConvertTo-Json), (New-Object Text.UTF8Encoding $false))
    Write-Output 'Development records and indexed files copied into the independent trial; source records preserved.'
} finally {
    $env:PGPASSWORD = $priorPassword
    if (Test-Path -LiteralPath $dump) { Remove-Item -LiteralPath $dump -Force }
    if ($apiWasRunning) { & (Join-Path $repository 'scripts/m0/runtime.ps1') app-start }
}
