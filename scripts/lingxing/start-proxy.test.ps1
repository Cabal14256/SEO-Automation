$ErrorActionPreference = 'Stop'
$scmScript = Join-Path $PSScriptRoot 'start-proxy.ps1'
$scmTokens = $null
$scmErrors = $null
$null = [Management.Automation.Language.Parser]::ParseFile($scmScript, [ref]$scmTokens, [ref]$scmErrors)
if ($scmErrors.Count) { throw 'PowerShell syntax check failed.' }
. $scmScript

Test-ProxySettings ([pscustomobject]@{ server = 'example.invalid'; port = 22; user = 'developer' })
foreach ($scmInvalid in @(
    @{ server = '-oProxyCommand=bad'; port = 22; user = 'developer' },
    @{ server = 'example.invalid'; port = 0; user = 'developer' },
    @{ server = 'example.invalid'; port = 65536; user = 'developer' },
    @{ server = 'example.invalid'; port = 22; user = 'bad user' }
)) {
    $scmRejected = $false
    try { Test-ProxySettings ([pscustomobject]$scmInvalid) } catch { $scmRejected = $true }
    if (-not $scmRejected) { throw 'Invalid SSH configuration was accepted.' }
}

[xml]$scmDocument = '<service><id>SCM-Local-API</id><env name="TZ" value="Asia/Shanghai"/><env name="HTTPS_PROXY" value="old"/><env name="HTTPS_PROXY" value="duplicate"/></service>'
Set-ProxyEnvironment $scmDocument
if ($scmDocument.service.SelectNodes("env[@name='HTTPS_PROXY']").Count -ne 1) { throw 'Duplicate proxy entries remain.' }
if ($scmDocument.service.SelectSingleNode("env[@name='HTTPS_PROXY']").GetAttribute('value') -ne 'http://127.0.0.1:18888') { throw 'Proxy value incorrect.' }
if ($scmDocument.service.SelectSingleNode("env[@name='NO_PROXY']").GetAttribute('value') -ne 'localhost,127.0.0.1,::1') { throw 'Local bypass missing.' }
if ($scmDocument.service.SelectSingleNode("env[@name='TZ']").GetAttribute('value') -ne 'Asia/Shanghai') { throw 'Unrelated environment changed.' }
if ($scmDocument.service.id -ne 'SCM-Local-API') { throw 'Service identity changed.' }
$scmBefore = $scmDocument.OuterXml
Set-ProxyEnvironment $scmDocument
if ($scmBefore -ne $scmDocument.OuterXml) { throw 'Repeated configuration is not idempotent.' }
if (-not (Test-ExitAddress '203.0.113.10')) { throw 'Valid IP rejected.' }
if (Test-ExitAddress '<html>proxy error</html>') { throw 'Invalid exit response accepted.' }

$scmGraph = @{
    api = [pscustomobject]@{ Name = 'api'; Status = 'Running'; DependentServices = @([pscustomobject]@{ Name = 'web'; Status = 'Running' }, [pscustomobject]@{ Name = 'inactive'; Status = 'Stopped' }) }
    web = [pscustomobject]@{ Name = 'web'; Status = 'Running'; DependentServices = @([pscustomobject]@{ Name = 'nested'; Status = 'Running' }) }
    nested = [pscustomobject]@{ Name = 'nested'; Status = 'Running'; DependentServices = @() }
    worker = [pscustomobject]@{ Name = 'worker'; Status = 'Stopped'; DependentServices = @() }
}
$scmPlan = @(Get-ProxyServiceRestartPlan @('api', 'worker') { param($ServiceName) $scmGraph[$ServiceName] })
if (($scmPlan.name -join ',') -ne 'nested,web,api,worker') { throw 'Dependent services must stop before parents.' }
if ($scmPlan[3].wasRunning -or -not $scmPlan[3].shouldStart) { throw 'Stopped target must start without being stopped first.' }
if ($scmPlan.name -contains 'inactive') { throw 'Stopped dependent should remain stopped.' }
$scmSharedPlan = @(Get-ProxyServiceRestartPlan @('api', 'web') { param($ServiceName) $scmGraph[$ServiceName] })
if (($scmSharedPlan.name -join ',') -ne 'nested,web,api') { throw 'Shared dependencies must not be restarted twice.' }
Write-Output 'PASS: syntax, SSH settings, XML preservation / deduplication / idempotence, exit IP, dependent service order / restoration plan. No SSH connections or service changes performed.'
