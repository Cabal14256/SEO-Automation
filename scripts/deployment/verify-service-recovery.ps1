[CmdletBinding()]
param([string]$ConfigPath = (Join-Path $PSScriptRoot '../../.local/trial/runtime.json'))
$ErrorActionPreference = 'Stop'
$config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
$checks = @()
foreach ($kind in @('api', 'worker')) {
    $name = $config.services.$kind
    if ($name -notmatch '^SCM-Trial-(API|Worker)$') { throw 'Only explicitly named trial application services may be exercised.' }
    $service = Get-CimInstance Win32_Service -Filter "Name='$name'"
    if ($service.State -ne 'Running' -or !$service.PathName.Contains($config.trialRoot)) { throw 'Expected trial service is not running.' }
    $entry = Join-Path $config.releasePath "apps/server/dist/$kind.js"
    $child = Get-CimInstance Win32_Process -Filter "ParentProcessId=$($service.ProcessId)" | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine.Contains($entry) } | Select-Object -First 1
    if (!$child) { throw 'Could not identify the exact trial child process.' }
    $before = $child.ProcessId
    $started = [DateTime]::UtcNow
    Stop-Process -Id $before -Force
    $deadline = $started.AddSeconds(60)
    $recovered = $false
    do {
        Start-Sleep -Milliseconds 500
        $service = Get-CimInstance Win32_Service -Filter "Name='$name'"
        $after = Get-CimInstance Win32_Process -Filter "ParentProcessId=$($service.ProcessId)" | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine.Contains($entry) } | Select-Object -First 1
        if ($after -and $after.ProcessId -ne $before) {
            try {
                $health = Invoke-RestMethod -Uri "http://127.0.0.1:$($config.apiPort)/api/v1/health" -TimeoutSec 3
                if ($health.database -eq 'ok' -and $health.worker -eq 'ok') { $recovered = $true; break }
            } catch { }
        }
    } while ([DateTime]::UtcNow -lt $deadline)
    if (!$recovered) { throw 'The trial service did not recover from its controlled process failure.' }
    $checks += [ordered]@{ service=$name; result='passed'; previousProcessId=$before; recoveredProcessId=$after.ProcessId; seconds=[math]::Round(([DateTime]::UtcNow-$started).TotalSeconds,2) }
}
# Also require a fresh, correctly bound Worker heartbeat after both failures.
& (Join-Path $PSScriptRoot 'trial.ps1') start -TrialRoot $config.trialRoot
if (!$?) { throw 'Post-recovery health verification failed.' }
$report = [ordered]@{ kind='controlled-trial-process-failure'; checkedAt=[DateTime]::UtcNow.ToString('o'); result='passed'; checks=$checks; externalBusinessRequests=0; operatingSystemRebootVerified=$false }
$path = Join-Path $config.trialRoot 'evidence/service-recovery.json'
[IO.File]::WriteAllText($path, ($report | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding $false))
$report | ConvertTo-Json -Depth 6
