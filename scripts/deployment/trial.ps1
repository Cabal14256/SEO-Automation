[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('provision', 'install', 'start', 'stop', 'status', 'trust', 'release')]
    [string]$Action = 'status',
    [string]$TrialRoot,
    [string]$ReleasePath,
    [string]$PostgresBin = 'C:\Program Files\PostgreSQL\18\bin',
    [string]$HostName = $env:COMPUTERNAME,
    [int]$ApiPort = 3002,
    [int]$PostgresPort = 55433,
    [string]$DownloadCache
)

$ErrorActionPreference = 'Stop'
$utf8 = New-Object Text.UTF8Encoding $false
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
. (Join-Path $PSScriptRoot '../shared/path-policy.ps1')
if (-not $TrialRoot) { $TrialRoot = Join-Path $repository '.local/trial' }
if (-not $DownloadCache) { $DownloadCache = Join-Path $repository '.local/development/runtime/t23-downloads' }
$TrialRoot = Resolve-ScmRuntimePath -Repository $repository -Path $TrialRoot -Role trial
$DownloadCache = Resolve-ScmRuntimePath -Repository $repository -Path $DownloadCache -Role development
$configPath = Join-Path $TrialRoot 'runtime.json'

function Write-Text([string]$Path, [string]$Value) { [IO.File]::WriteAllText($Path, $Value, $utf8) }
function New-Secret {
    $bytes = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    return [BitConverter]::ToString($bytes).Replace('-', '').ToLowerInvariant()
}
function Assert-Native { if ($LASTEXITCODE -ne 0) { throw 'External command failed; inspect the controlled local logs.' } }
function Read-Config {
    if (!(Test-Path -LiteralPath $configPath -PathType Leaf)) { throw 'Provision the trial environment first.' }
    $value = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ([IO.Path]::GetFullPath($value.trialRoot).TrimEnd('\') -ne $TrialRoot) { throw 'Trial root does not match the configuration.' }
    return $value
}
function Assert-Release([string]$Path) {
    $absolute = Resolve-ScmRuntimePath -Repository $repository -Path $Path -Role release
    $releases = Join-Path $TrialRoot 'releases'
    if (!$absolute.StartsWith($releases + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Release must be under this trial releases directory.' }
    $physical = Resolve-ScmPhysicalPath $absolute
    $physicalReleases = Resolve-ScmPhysicalPath $releases
    if (!$physical.StartsWith($physicalReleases + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Release resolves outside this trial releases directory.' }
    & node (Join-Path $PSScriptRoot 'check-release.mjs') $absolute
    Assert-Native
}
function Invoke-Pg([string]$Executable, [string[]]$Arguments) {
    & (Join-Path $script:config.postgresBin $Executable) @Arguments
    Assert-Native
}
function Set-DirectoryAccess {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    & icacls $TrialRoot /inheritance:r /grant:r "${identity}:(OI)(CI)F" 'SYSTEM:(OI)(CI)F' 'BUILTIN\Administrators:(OI)(CI)F' 'NT AUTHORITY\LOCAL SERVICE:(OI)(CI)RX' | Out-Null
    Assert-Native
    foreach ($path in @('data', 'postgres', 'runtime', 'caddy-data', 'caddy-config')) {
        & icacls (Join-Path $TrialRoot $path) /grant:r 'NT AUTHORITY\LOCAL SERVICE:(OI)(CI)M' | Out-Null
        Assert-Native
    }
}
function Write-Service([string]$Id, [string]$Executable, [string]$Arguments, [string]$WorkingDirectory, [string]$EnvironmentXml, [string]$Dependency) {
    $directory = Join-Path $TrialRoot "services/$Id"
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $TrialRoot 'tools/WinSW-x64.exe') -Destination (Join-Path $directory "$Id.exe") -Force
    $xmlEscape = { param($text) [Security.SecurityElement]::Escape($text) }
    $dependencyXml = if ($Dependency) { '<depend>' + (& $xmlEscape $Dependency) + '</depend>' } else { '' }
    $xml = @"
<service>
  <id>$Id</id><name>$Id</name><description>SCM first-release trial service</description>
  <executable>$(& $xmlEscape $Executable)</executable><arguments>$(& $xmlEscape $Arguments)</arguments>
  <workingdirectory>$(& $xmlEscape $WorkingDirectory)</workingdirectory>
  <startmode>Automatic</startmode><stoptimeout>45sec</stoptimeout>
  <onfailure action="restart" delay="5sec"/><resetfailure>1hour</resetfailure>
  <logpath>$(& $xmlEscape (Join-Path $TrialRoot "runtime/$Id"))</logpath>
  <log mode="roll-by-size"><sizeThreshold>10240</sizeThreshold><keepFiles>10</keepFiles></log>
  $dependencyXml
  $EnvironmentXml
</service>
"@
    Write-Text (Join-Path $directory "$Id.xml") $xml
    New-Item -ItemType Directory -Path (Join-Path $TrialRoot "runtime/$Id") -Force | Out-Null
}
function Write-Services {
    $release = $script:config.releasePath
    if (!(Test-Path -LiteralPath (Join-Path $release 'apps/server/dist/api.js'))) { throw 'Release API build is missing.' }
    $node = Join-Path $release 'runtime/node.exe'
    if (!(Test-Path -LiteralPath $node)) { throw 'Release must include its Node runtime.' }
    $escapedEnv = [Security.SecurityElement]::Escape($script:config.envPath)
    $envXml = "<env name=`"DOTENV_CONFIG_PATH`" value=`"$escapedEnv`"/><env name=`"DOTENV_CONFIG_OVERRIDE`" value=`"true`"/><env name=`"NODE_ENV`" value=`"production`"/><env name=`"TZ`" value=`"Asia/Shanghai`"/>"
    Write-Service $script:config.services.api $node ('"' + (Join-Path $release 'apps/server/dist/api.js') + '"') (Join-Path $release 'apps/server') $envXml $script:config.services.postgres
    Write-Service $script:config.services.worker $node ('"' + (Join-Path $release 'apps/server/dist/worker.js') + '"') (Join-Path $release 'apps/server') $envXml $script:config.services.postgres
    $data = [Security.SecurityElement]::Escape((Join-Path $TrialRoot 'caddy-data'))
    $caddyConfig = [Security.SecurityElement]::Escape((Join-Path $TrialRoot 'caddy-config'))
    Write-Service $script:config.services.https (Join-Path $TrialRoot 'tools/caddy.exe') ('run --config "' + (Join-Path $TrialRoot 'config/Caddyfile') + '" --adapter caddyfile') $TrialRoot "<env name=`"XDG_DATA_HOME`" value=`"$data`"/><env name=`"XDG_CONFIG_HOME`" value=`"$caddyConfig`"/>" $script:config.services.api
}
function Get-CheckedService([string]$Name) {
    $service = Get-CimInstance Win32_Service -Filter "Name='$Name'" -ErrorAction SilentlyContinue
    if ($service -and (!$service.PathName -or !$service.PathName.Contains($TrialRoot))) { throw 'Service name belongs to a different environment.' }
    return $service
}
function Start-Trial {
    $startedAt = [DateTime]::UtcNow.ToString('o')
    foreach ($name in @($script:config.services.postgres, $script:config.services.api, $script:config.services.worker, $script:config.services.https)) {
        if (!(Get-CheckedService $name)) { throw 'Install the trial services first.' }
        Start-Service -Name $name
    }
    $deadline = [DateTime]::UtcNow.AddSeconds(45)
    do {
        try {
            $services = @($script:config.services.postgres, $script:config.services.api, $script:config.services.worker, $script:config.services.https)
            if (@($services | Where-Object { (Get-CheckedService $_).State -ne 'Running' }).Count) { throw 'Service is not running.' }
            $response = Invoke-RestMethod -Uri "http://127.0.0.1:$($script:config.apiPort)/api/v1/health" -TimeoutSec 3
            $workerService = Get-CheckedService $script:config.services.worker
            $worker = Get-CimInstance Win32_Process -Filter "ParentProcessId=$($workerService.ProcessId)" | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine.Contains((Join-Path $script:config.releasePath 'apps/server/dist/worker.js')) } | Select-Object -First 1
            if ($response.database -eq 'ok' -and $response.worker -eq 'ok' -and $worker) {
                $priorPassword = $env:PGPASSWORD
                try {
                    $env:PGPASSWORD = $script:config.appPassword
                    $fresh = & (Join-Path $script:config.postgresBin 'psql.exe') -X -w -h 127.0.0.1 -p $script:config.postgresPort -U $script:config.appUser -d $script:config.database -t -A -c "select count(*) from worker_heartbeat where process_id=$($worker.ProcessId) and last_seen_at >= '$startedAt'::timestamptz;"
                    if ($LASTEXITCODE -eq 0 -and [int]$fresh -eq 1) { return }
                } finally { $env:PGPASSWORD = $priorPassword }
            }
        } catch { }
        Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $deadline)
    throw 'Trial API/Worker did not become healthy; inspect the controlled service logs.'
}
function Stop-Trial {
    foreach ($name in @($script:config.services.https, $script:config.services.worker, $script:config.services.api, $script:config.services.postgres)) {
        if (Get-CheckedService $name) { Stop-Service -Name $name }
    }
}

switch ($Action) {
    'provision' {
        if (Test-Path -LiteralPath $TrialRoot) {
            $existing = @(Get-ChildItem -LiteralPath $TrialRoot -Force)
            if (@($existing | Where-Object { $_.Name -ne 'releases' -or !$_.PSIsContainer }).Count) {
                throw 'Existing trial directory is preserved. Only a new releases directory may precede provisioning.'
            }
        }
        if (!$ReleasePath -or !(Test-Path -LiteralPath $ReleasePath -PathType Container)) { throw 'Supply an existing immutable release directory.' }
        Assert-Release $ReleasePath
        if ($HostName -notmatch '^[a-zA-Z0-9][a-zA-Z0-9.-]*$') { throw 'HostName is invalid.' }
        $HostName = $HostName.ToLowerInvariant()
        foreach ($port in @($ApiPort, $PostgresPort, 443)) {
            if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) { throw 'A requested trial port is already listening.' }
        }
        foreach ($name in @('data', 'postgres', 'config', 'runtime', 'tools', 'services', 'backups', 'evidence', 'caddy-data', 'caddy-config')) {
            New-Item -ItemType Directory -Path (Join-Path $TrialRoot $name) -Force | Out-Null
        }
        $config = [pscustomobject][ordered]@{
            schemaVersion = 1; trialRoot = $TrialRoot; releasePath = [IO.Path]::GetFullPath($ReleasePath)
            dataDir = Join-Path $TrialRoot 'data'; envPath = Join-Path $TrialRoot 'config/app.env'
            postgresBin = $PostgresBin; postgresDataDir = Join-Path $TrialRoot 'postgres'; postgresPort = $PostgresPort
            database = 'scm_automation_trial'; appUser = 'scm_app'; ownerUser = 'scm_trial_owner'
            ownerPassword = New-Secret; appPassword = New-Secret; apiPort = $ApiPort
            runtimeDir = Join-Path $TrialRoot 'runtime'; backupDir = Join-Path $TrialRoot 'backups'
            keyPath = Join-Path $repository '.local/development/recovery/trial-backup.key'
            publicUrl = "https://$HostName"; services = @{ api='SCM-Trial-API'; worker='SCM-Trial-Worker'; postgres='SCM-Trial-Postgres'; https='SCM-Trial-HTTPS' }
        }
        Write-Text $configPath (($config | ConvertTo-Json -Depth 6) + "`n")
        Set-DirectoryAccess
        $passwordFile = Join-Path $TrialRoot 'config/initdb-password.tmp'
        try {
            Write-Text $passwordFile $config.ownerPassword
            Invoke-Pg 'initdb.exe' @('-D', $config.postgresDataDir, '-U', $config.ownerUser, '--encoding=UTF8', '--locale=C', '--auth-host=scram-sha-256', '--auth-local=scram-sha-256', "--pwfile=$passwordFile")
        } finally { if (Test-Path -LiteralPath $passwordFile) { Remove-Item -LiteralPath $passwordFile -Force } }
        @("listen_addresses = '127.0.0.1'", "port = $PostgresPort", "timezone = 'Asia/Shanghai'", "log_timezone = 'Asia/Shanghai'", "password_encryption = 'scram-sha-256'") | Add-Content -LiteralPath (Join-Path $config.postgresDataDir 'postgresql.conf') -Encoding ascii
        $previous = $env:PGPASSWORD
        $sqlPath = Join-Path $TrialRoot 'config/provision.tmp.sql'
        try {
            Invoke-Pg 'pg_ctl.exe' @('start', '-D', $config.postgresDataDir, '-l', (Join-Path $config.runtimeDir 'postgres-bootstrap.log'), '-w')
            $env:PGPASSWORD = $config.ownerPassword
            Write-Text $sqlPath ("CREATE ROLE scm_app LOGIN PASSWORD '$($config.appPassword)' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;`nCREATE DATABASE scm_automation_trial OWNER scm_app;`nREVOKE ALL ON DATABASE scm_automation_trial FROM PUBLIC;`n")
            Invoke-Pg 'psql.exe' @('-X', '-w', '-h', '127.0.0.1', '-p', "$PostgresPort", '-U', $config.ownerUser, '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-f', $sqlPath)
        } finally {
            $env:PGPASSWORD = $previous
            if (Test-Path -LiteralPath $sqlPath) { Remove-Item -LiteralPath $sqlPath -Force }
            Invoke-Pg 'pg_ctl.exe' @('stop', '-D', $config.postgresDataDir, '-m', 'fast', '-w')
        }
        $environment = @("DATABASE_URL=postgresql://scm_app:$($config.appPassword)@127.0.0.1:$PostgresPort/scm_automation_trial", "BETTER_AUTH_SECRET=$(New-Secret)", "BETTER_AUTH_URL=$($config.publicUrl)", "WEB_ORIGIN=$($config.publicUrl)", 'HOST=127.0.0.1', "PORT=$ApiPort", "DATA_DIR=$($config.dataDir.Replace('\','/'))", "WEB_DIST_DIR=$($config.releasePath.Replace('\','/'))/apps/web/dist", 'LINGXING_REQUESTS_ENABLED=false', 'TZ=Asia/Shanghai')
        Write-Text $config.envPath (($environment -join "`n") + "`n")
        Write-Text (Join-Path $TrialRoot 'config/Caddyfile') (@"
{
  admin 127.0.0.1:2019
  skip_install_trust
}
$HostName {
  tls internal
  encode zstd gzip
  reverse_proxy 127.0.0.1:$ApiPort
  log {
    output file $($TrialRoot.Replace('\','/'))/runtime/https-access.json {
      roll_size 10MiB
      roll_keep 10
    }
  }
}
"@)
        Write-Output 'Trial cluster provisioned. Install the release and services next; no source database was changed.'
    }
    'install' {
        $config = Read-Config
        Assert-Release $config.releasePath
        $tools = Join-Path $TrialRoot 'tools'
        foreach ($file in @('WinSW-x64.exe', 'caddy_2.11.7_windows_amd64.zip', 'caddy_2.11.7_checksums.txt')) {
            if (!(Test-Path -LiteralPath (Join-Path $DownloadCache $file))) { throw 'Pinned service binaries must be present in DownloadCache.' }
        }
        $archive = Join-Path $DownloadCache 'caddy_2.11.7_windows_amd64.zip'
        $line = Get-Content -LiteralPath (Join-Path $DownloadCache 'caddy_2.11.7_checksums.txt') | Where-Object { $_ -match '\s+caddy_2\.11\.7_windows_amd64\.zip$' }
        $expected = ($line -split '\s+')[0]
        $algorithm = if ($expected -match '^[a-fA-F0-9]{128}$') { 'SHA512' } elseif ($expected -match '^[a-fA-F0-9]{64}$') { 'SHA256' } else { throw 'Unsupported published Caddy checksum format.' }
        if (!$line -or ($expected -ne (Get-FileHash -LiteralPath $archive -Algorithm $algorithm).Hash)) { throw 'Caddy archive checksum does not match its published manifest.' }
        if ((Get-FileHash -LiteralPath (Join-Path $DownloadCache 'WinSW-x64.exe') -Algorithm SHA256).Hash -ne '05B82D46AD331CC16BDC00DE5C6332C1EF818DF8CEEFCD49C726553209B3A0DA') { throw 'WinSW does not match the pinned official release bytes.' }
        Copy-Item -LiteralPath (Join-Path $DownloadCache 'WinSW-x64.exe') -Destination $tools -Force
        Expand-Archive -LiteralPath $archive -DestinationPath $tools -Force
        Write-Services
        $database = Get-CheckedService $config.services.postgres
        if (!$database) {
            Invoke-Pg 'pg_ctl.exe' @('register', '-N', $config.services.postgres, '-D', $config.postgresDataDir, '-S', 'auto', '-U', 'NT AUTHORITY\LocalService')
        }
        foreach ($name in @($config.services.api, $config.services.worker, $config.services.https)) {
            if (!(Get-CheckedService $name)) { & (Join-Path $TrialRoot "services/$name/$name.exe") install; Assert-Native }
            & sc.exe config $name obj= 'NT AUTHORITY\LocalService' password= '""' | Out-Null
            Assert-Native
        }
        foreach ($name in @($config.services.postgres, $config.services.api, $config.services.worker, $config.services.https)) {
            & sc.exe failure $name reset= 3600 actions= restart/5000/restart/10000/restart/30000 | Out-Null
            Assert-Native
        }
        Set-DirectoryAccess
        $ruleName = 'SCM-Trial-HTTPS-LAN'
        if (!(Get-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue)) {
            New-NetFirewallRule -Name $ruleName -DisplayName 'SCM trial HTTPS on local subnet' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 443 -RemoteAddress LocalSubnet -Profile Any -Program (Join-Path $tools 'caddy.exe') | Out-Null
        }
        Write-Output 'Independent automatic services installed; PostgreSQL and API remain loopback-only.'
    }
    'start' { $config = Read-Config; Start-Trial }
    'stop' { $config = Read-Config; Stop-Trial }
    'trust' {
        $config = Read-Config
        $certificate = Join-Path $TrialRoot 'caddy-data/caddy/pki/authorities/local/root.crt'
        if (!(Test-Path -LiteralPath $certificate)) { throw 'Start HTTPS once to generate the internal CA.' }
        Import-Certificate -FilePath $certificate -CertStoreLocation Cert:\LocalMachine\Root | Select-Object Subject,Thumbprint
        Copy-Item -LiteralPath $certificate -Destination (Join-Path $TrialRoot 'evidence/https-root.crt') -Force
        Write-Output 'This machine trusts the trial CA. Other clients must explicitly trust its public root certificate.'
    }
    'release' {
        $config = Read-Config
        if (!$ReleasePath -or !(Test-Path -LiteralPath (Join-Path $ReleasePath 'apps/server/dist/api.js'))) { throw 'A built release is required.' }
        foreach ($file in @('apps/server/dist/worker.js', 'apps/web/dist/index.html', 'runtime/node.exe', 'release-manifest.json')) {
            if (!(Test-Path -LiteralPath (Join-Path $ReleasePath $file))) { throw 'Release is incomplete; existing services preserved.' }
        }
        Assert-Release $ReleasePath
        $savedConfig = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8
        $savedEnvironment = Get-Content -LiteralPath $config.envPath -Raw -Encoding UTF8
        foreach ($name in @($config.services.https, $config.services.worker, $config.services.api)) { if (Get-CheckedService $name) { Stop-Service -Name $name } }
        try {
            $prior = $config.releasePath
            $config | Add-Member NoteProperty previousReleasePath $prior -Force
            $config.releasePath = [IO.Path]::GetFullPath($ReleasePath)
            $environment = [regex]::Replace($savedEnvironment, '(?m)^WEB_DIST_DIR=.*$', ('WEB_DIST_DIR=' + $config.releasePath.Replace('\','/') + '/apps/web/dist'))
            Write-Text $config.envPath $environment
            Write-Text $configPath (($config | ConvertTo-Json -Depth 6) + "`n")
            Write-Services
            Start-Trial
        } catch {
            foreach ($name in @($config.services.https, $config.services.worker, $config.services.api)) {
                if ((Get-Service -Name $name -ErrorAction SilentlyContinue).Status -eq 'Running') { Stop-Service -Name $name }
            }
            Write-Text $configPath $savedConfig
            $config = Read-Config
            Write-Text $config.envPath $savedEnvironment
            Write-Services
            Start-Trial
            throw 'Selected release failed health checks; the previous release and configuration were restored.'
        }
        Write-Output 'Trial services now use the selected release; the previous path remains recorded for rollback.'
    }
    'status' {
        $config = Read-Config
        foreach ($name in @($config.services.postgres, $config.services.api, $config.services.worker, $config.services.https)) {
            $service = Get-CheckedService $name
            if ($service) { [pscustomobject]@{ Name=$name; State=$service.State; StartMode=$service.StartMode; Account=$service.StartName } }
        }
    }
}
