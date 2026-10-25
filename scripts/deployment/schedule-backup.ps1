[CmdletBinding()]
param([string]$ConfigPath = (Join-Path $PSScriptRoot '../../.local/trial/runtime.json'))
$ErrorActionPreference = 'Stop'
$config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
$launcher = Join-Path $config.trialRoot 'config/run-backup.ps1'
$escapedPath = $ConfigPath.Replace("'", "''")
$script = @'
$ErrorActionPreference = 'Stop'
$configPath = '__CONFIG__'
$config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
$log = Join-Path $config.runtimeDir ('daily-backup-' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss') + '.json')
& (Join-Path $config.releasePath 'runtime/node.exe') (Join-Path $config.releasePath 'scripts/trial/cli.mjs') backup --config $configPath > $log 2>&1
exit $LASTEXITCODE
'@
[IO.File]::WriteAllText($launcher, $script.Replace('__CONFIG__', $escapedPath), (New-Object Text.UTF8Encoding $false))
$action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$launcher`""
$trigger = New-ScheduledTaskTrigger -Daily -At '02:00'
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
$name = 'SCM-Trial-DailyBackup'
$existing = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
if ($existing -and $existing.Actions.Arguments -notcontains $action.Arguments) { throw 'Task name is already used by a different command.' }
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Encrypted SCM trial backup; current destination is local staging until independent media is configured.' -Force | Select-Object TaskName,State
