param(
    [string]$LocalRoot,
    [string]$DataDir,
    [string]$PostgresBin = 'C:\Program Files\PostgreSQL\18\bin',
    [int]$PostgresPort = 55432
)
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
. (Join-Path $PSScriptRoot '../shared/path-policy.ps1')
if (-not $LocalRoot) { $LocalRoot = Join-Path $projectRoot '.local/development' }
$envPath = Join-Path $projectRoot 'apps/server/.env'
$localConfigPath = Join-Path $projectRoot '.local/m0-runtime.json'
$utf8 = New-Object System.Text.UTF8Encoding $false

function Resolve-ExternalDirectory([string]$Path) {
    return Resolve-ScmRuntimePath -Repository $projectRoot -Path $Path -Role development
}

function New-SecretHex([int]$ByteCount) {
    $bytes = New-Object byte[] $ByteCount
    $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $generator.GetBytes($bytes) } finally { $generator.Dispose() }
    return [BitConverter]::ToString($bytes).Replace('-', '').ToLowerInvariant()
}

$LocalRoot = Resolve-ExternalDirectory $LocalRoot
if (-not $DataDir) { $DataDir = Join-Path $LocalRoot 'data' }
$DataDir = Resolve-ScmRuntimePath -Repository $projectRoot -Path $DataDir -Role data
$runtimePath = Join-Path $LocalRoot 'runtime.json'
if ((Test-Path -LiteralPath $runtimePath) -or (Test-Path -LiteralPath $envPath) -or (Test-Path -LiteralPath $localConfigPath)) {
    throw 'Existing runtime, .env or local process configuration preserved. Use runtime.ps1 to start the configured environment.'
}
if ($PostgresPort -lt 1 -or $PostgresPort -gt 65535) { throw 'PostgresPort must be a valid TCP port' }
foreach ($executable in @('postgres.exe', 'initdb.exe', 'pg_ctl.exe', 'psql.exe')) {
    if (-not (Test-Path -LiteralPath (Join-Path $PostgresBin $executable) -PathType Leaf)) { throw 'Install PostgreSQL 18 and set PostgresBin to its bin directory' }
}
$postgresVersion = & (Join-Path $PostgresBin 'postgres.exe') --version
if ($LASTEXITCODE -ne 0 -or $postgresVersion -notmatch '\b18\.') { throw 'PostgreSQL 18 is required' }
if (Get-NetTCPConnection -LocalPort $PostgresPort -State Listen -ErrorAction SilentlyContinue) { throw 'Selected PostgreSQL port is already in use' }
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
foreach ($directory in @($LocalRoot, $DataDir)) {
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    & icacls $directory /inheritance:r /grant:r "${identity}:(OI)(CI)F" 'SYSTEM:(OI)(CI)F' | Out-Null
    if ($LASTEXITCODE) { throw 'Could not restrict local directory permissions' }
}
$runtime = [ordered]@{
    postgresBin = $PostgresBin
    postgresDir = Join-Path $LocalRoot 'postgres'
    postgresPort = $PostgresPort
    database = 'scm_automation_dev'
    appUser = 'scm_app'
    ownerUser = 'scm_local_owner'
    ownerPassword = New-SecretHex 32
    appPassword = New-SecretHex 32
}
[IO.File]::WriteAllText($runtimePath, ($runtime | ConvertTo-Json) + [Environment]::NewLine, $utf8)
$passwordFile = Join-Path $LocalRoot 'initdb-password.tmp'
try {
    $runtime.ownerPassword | Set-Content -LiteralPath $passwordFile -NoNewline -Encoding ascii
    & "$PostgresBin/initdb.exe" -D $runtime.postgresDir -U $runtime.ownerUser --encoding=UTF8 --locale=C --auth-host=scram-sha-256 --auth-local=scram-sha-256 "--pwfile=$passwordFile"
    if ($LASTEXITCODE) { throw 'initdb failed; inspect local runtime directory before retrying' }
} finally { if (Test-Path -LiteralPath $passwordFile) { Remove-Item -LiteralPath $passwordFile -Force } }
@("listen_addresses = '127.0.0.1'", "port = $PostgresPort", "timezone = 'Asia/Shanghai'", "log_timezone = 'Asia/Shanghai'", "password_encryption = 'scram-sha-256'") | Add-Content -LiteralPath (Join-Path $runtime.postgresDir 'postgresql.conf') -Encoding ascii
& "$PostgresBin/pg_ctl.exe" -D $runtime.postgresDir -l (Join-Path $LocalRoot 'postgres.log') -w start
if ($LASTEXITCODE) { throw 'Could not start independent PostgreSQL instance' }
$sqlPath = Join-Path $LocalRoot 'create-app.tmp.sql'
$previousPassword = $env:PGPASSWORD
try {
    $env:PGPASSWORD = $runtime.ownerPassword
    @("CREATE ROLE scm_app LOGIN PASSWORD '$($runtime.appPassword)' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;", 'CREATE DATABASE scm_automation_dev OWNER scm_app;', "ALTER DATABASE scm_automation_dev SET timezone TO 'Asia/Shanghai';", 'REVOKE ALL ON DATABASE scm_automation_dev FROM PUBLIC;', 'GRANT CONNECT ON DATABASE scm_automation_dev TO scm_app;') | Set-Content -LiteralPath $sqlPath -Encoding ascii
    & "$PostgresBin/psql.exe" -X -w -h 127.0.0.1 -p $PostgresPort -U $runtime.ownerUser -d postgres -v ON_ERROR_STOP=1 -f $sqlPath
    if ($LASTEXITCODE) { throw 'Database provisioning failed' }
} finally {
    $env:PGPASSWORD = $previousPassword
    if (Test-Path -LiteralPath $sqlPath) { Remove-Item -LiteralPath $sqlPath -Force }
}
$appEnvironment = @("DATABASE_URL=postgresql://scm_app:$($runtime.appPassword)@127.0.0.1:$PostgresPort/scm_automation_dev", "BETTER_AUTH_SECRET=$(New-SecretHex 48)", 'BETTER_AUTH_URL=http://localhost:3001', 'WEB_ORIGIN=http://localhost:5173', 'HOST=127.0.0.1', 'PORT=3001', "DATA_DIR=$($DataDir.Replace('\', '/'))", 'TZ=Asia/Shanghai')
[IO.File]::WriteAllText($envPath, ($appEnvironment -join [Environment]::NewLine) + [Environment]::NewLine, $utf8)
& icacls $envPath /inheritance:r /grant:r "${identity}:F" 'SYSTEM:F' | Out-Null
if ($LASTEXITCODE) { throw 'Could not restrict .env permissions' }
$processConfig = [ordered]@{
    postgresBin = $PostgresBin.Replace('\', '/')
    postgresDataDir = $runtime.postgresDir.Replace('\', '/')
    postgresPort = $PostgresPort
    runtimeDir = (Join-Path $LocalRoot 'runtime').Replace('\', '/')
    healthUrl = 'http://127.0.0.1:3001/api/v1/health'
}
New-Item -ItemType Directory -Path (Split-Path $localConfigPath -Parent) -Force | Out-Null
[IO.File]::WriteAllText($localConfigPath, ($processConfig | ConvertTo-Json) + [Environment]::NewLine, $utf8)
Write-Output "Independent PostgreSQL configured on 127.0.0.1:$PostgresPort. Run corepack pnpm db:migrate."
