[CmdletBinding()]
param(
    [string]$ConfigPath,
    [switch]$Configure,
    [switch]$TunnelOnly,
    [switch]$NoPause
)

$ErrorActionPreference = 'Stop'
$scmRepository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
if (-not $ConfigPath) { $ConfigPath = Join-Path $scmRepository '.local/lingxing-proxy.local.json' }
$ConfigPath = [IO.Path]::GetFullPath($ConfigPath)

function Test-ProxySettings($Settings) {
    if (-not $Settings -or [string]$Settings.server -notmatch '^[a-zA-Z0-9][a-zA-Z0-9.-]*$' -or
        [string]$Settings.user -notmatch '^[a-zA-Z_][a-zA-Z0-9_.-]*$' -or
        [string]$Settings.port -notmatch '^\d{1,5}$' -or [int]$Settings.port -lt 1 -or [int]$Settings.port -gt 65535) {
        throw '服务器配置无效。请使用服务器 IPv4 / 域名、有效 SSH 端口和 Ubuntu 用户名。'
    }
}

function Set-ProxyEnvironment([xml]$Document) {
    if (-not $Document.service) { throw '服务 XML 缺少 service 根节点。' }
    $scmValues = [ordered]@{
        HTTP_PROXY = 'http://127.0.0.1:18888'
        HTTPS_PROXY = 'http://127.0.0.1:18888'
        NO_PROXY = 'localhost,127.0.0.1,::1'
        NODE_USE_ENV_PROXY = '1'
    }
    foreach ($scmKey in $scmValues.Keys) {
        $scmNodes = @($Document.service.SelectNodes("env[@name='$scmKey']"))
        if ($scmNodes.Count -gt 0) {
            $scmNode = $scmNodes[0]
            foreach ($scmDuplicate in ($scmNodes | Select-Object -Skip 1)) { $null = $Document.service.RemoveChild($scmDuplicate) }
        } else {
            $scmNode = $Document.CreateElement('env')
            $scmNode.SetAttribute('name', $scmKey)
            $null = $Document.service.AppendChild($scmNode)
        }
        $scmNode.SetAttribute('value', $scmValues[$scmKey])
    }
}

function Test-ExitAddress([string]$Address) {
    $scmParsedAddress = $null
    return [Net.IPAddress]::TryParse($Address.Trim(), [ref]$scmParsedAddress)
}

function Get-ProxyServiceRestartPlan([string[]]$Names, [scriptblock]$ReadService = { param($ServiceName) Get-Service -Name $ServiceName -ErrorAction Stop }) {
    $scmVisited = @{}
    $scmOrder = New-Object 'System.Collections.Generic.List[object]'
    $scmVisit = {
        param([string]$ServiceName)
        if ($scmVisited.ContainsKey($ServiceName)) { return }
        $scmVisited[$ServiceName] = $true
        $scmService = & $ReadService $ServiceName
        foreach ($scmDependent in $scmService.DependentServices) {
            if ([string]$scmDependent.Status -ne 'Stopped') { & $scmVisit $scmDependent.Name }
        }
        $scmOrder.Add([pscustomobject]@{
            name = $scmService.Name
            wasRunning = ([string]$scmService.Status -ne 'Stopped')
            shouldStart = ($Names -contains $scmService.Name -or [string]$scmService.Status -ne 'Stopped')
        })
    }
    foreach ($scmName in $Names) { & $scmVisit $scmName }
    return $scmOrder.ToArray()
}

function Restart-ProxyServices([string[]]$Names) {
    $scmPlan = @(Get-ProxyServiceRestartPlan $Names)
    try {
        # Stop leaf dependents first; start in reverse so prerequisites are available.
        foreach ($scmEntry in $scmPlan) {
            if ($scmEntry.wasRunning) {
                Write-Host "正在停止 $($scmEntry.name)…"
                Stop-Service -Name $scmEntry.name -ErrorAction Stop
            }
        }
        for ($scmIndex = $scmPlan.Count - 1; $scmIndex -ge 0; $scmIndex--) {
            if ($scmPlan[$scmIndex].shouldStart) {
                Write-Host "正在启动 $($scmPlan[$scmIndex].name)…"
                Start-Service -Name $scmPlan[$scmIndex].name -ErrorAction Stop
            }
        }
    } catch {
        # Best effort restoration also covers a failure partway through stopping services.
        $scmRestartError = $_
        for ($scmIndex = $scmPlan.Count - 1; $scmIndex -ge 0; $scmIndex--) {
            if ($scmPlan[$scmIndex].wasRunning) {
                try { Start-Service -Name $scmPlan[$scmIndex].name -ErrorAction Stop }
                catch { Write-Warning "未能恢复服务 $($scmPlan[$scmIndex].name)，请检查服务日志。" }
            }
        }
        throw $scmRestartError
    }
}

function Get-ProxyExitAddress {
    $scmOutput = & curl.exe --silent --show-error --fail --max-time 15 --noproxy 'localhost,127.0.0.1,::1' --proxy http://127.0.0.1:18888 https://checkip.amazonaws.com 2>$null
    if ($LASTEXITCODE -ne 0) { throw '代理出口检查失败。请检查 SSH 登录、云端 Tinyproxy 和服务器外网连接。' }
    $scmAddress = ($scmOutput -join '').Trim()
    if (-not (Test-ExitAddress $scmAddress)) { throw '代理出口返回的内容不是 IP 地址。' }
    return $scmAddress
}

function Get-TunnelListener {
    return @(Get-NetTCPConnection -State Listen -LocalPort 18888 -ErrorAction SilentlyContinue)
}

function Assert-ExpectedTunnel($Listeners, $Settings) {
    foreach ($scmListener in $Listeners) {
        $scmProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $($scmListener.OwningProcess)"
        $scmTarget = "$($Settings.user)@$($Settings.server)"
        if ($scmListener.LocalAddress -ne '127.0.0.1' -or -not $scmProcess -or $scmProcess.Name -ne 'ssh.exe' -or
            -not $scmProcess.CommandLine.Contains('127.0.0.1:18888:127.0.0.1:18888') -or
            $scmProcess.CommandLine -notmatch ('(?:^|\s)' + [regex]::Escape($scmTarget) + '(?:\s|$)')) {
            throw '18888 端口已被其他程序或其他 SSH 隧道占用。请先核对并关闭冲突程序，再运行本脚本。'
        }
    }
}

# Dot sourcing exposes pure helpers for offline checks without starting services or SSH.
if ($MyInvocation.InvocationName -eq '.') { return }

try {
    if (-not $TunnelOnly) {
        $scmIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
        $scmPrincipal = New-Object Security.Principal.WindowsPrincipal($scmIdentity)
        if (-not $scmPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
            Write-Host '需要管理员权限来更新并重启本机 API / Worker 服务。'
            $scmArguments = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -ConfigPath `"$ConfigPath`""
            if ($Configure) { $scmArguments += ' -Configure' }
            if ($NoPause) { $scmArguments += ' -NoPause' }
            $scmElevated = Start-Process powershell.exe -Verb RunAs -WindowStyle Normal -ArgumentList $scmArguments -Wait -PassThru
            exit $scmElevated.ExitCode
        }
    }

    if (-not (Get-Command ssh.exe -ErrorAction SilentlyContinue) -or -not (Get-Command curl.exe -ErrorAction SilentlyContinue)) {
        throw '缺少 Windows OpenSSH 客户端或 curl.exe，请先安装 Windows OpenSSH 客户端。'
    }

    if ($Configure -or -not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
        if ($TunnelOnly) { throw '请先运行主脚本填写服务器配置。' }
        Write-Host '首次配置（不保存密码或私钥；默认使用 Windows OpenSSH 的已有认证配置）'
        $scmServer = (Read-Host 'Ubuntu 服务器公网 IPv4 或域名').Trim()
        $scmPort = (Read-Host 'SSH 端口（回车使用 22）').Trim()
        if (-not $scmPort) { $scmPort = '22' }
        $scmUser = (Read-Host 'Ubuntu SSH 登录用户名').Trim()
        $scmSettings = [pscustomobject]@{ server = $scmServer; port = $scmPort; user = $scmUser }
        Test-ProxySettings $scmSettings
        $null = New-Item -ItemType Directory -Path (Split-Path $ConfigPath -Parent) -Force
        [IO.File]::WriteAllText($ConfigPath, ($scmSettings | ConvertTo-Json), (New-Object Text.UTF8Encoding $false))
    } else {
        $scmSettings = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
        Test-ProxySettings $scmSettings
    }

    if ($TunnelOnly) {
        $Host.UI.RawUI.WindowTitle = 'SCM 领星 SSH 隧道 - 请保持此窗口打开'
        Write-Host '如需密码，请输入 Ubuntu SSH 登录密码；首次连接请核对服务器指纹。'
        Write-Host '此窗口用于交互登录并保持隧道，关闭后领星查询将中断。'
        $scmSshArguments = @('-N', '-T', '-L', '127.0.0.1:18888:127.0.0.1:18888', '-p', [string]$scmSettings.port,
            '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3',
            '-o', 'ConnectTimeout=15', "$($scmSettings.user)@$($scmSettings.server)")
        & ssh.exe @scmSshArguments
        throw 'SSH 隧道已退出。请检查上方 SSH 提示，重新运行一键启动脚本。'
    }

    # Validate both services and XML before starting the tunnel or changing files.
    $scmServiceRoot = Join-Path $scmRepository '.local/development/services'
    $scmServices = @('SCM-Local-API', 'SCM-Local-Worker')
    $scmPlans = @()
    foreach ($scmName in $scmServices) {
        $null = Get-Service -Name $scmName -ErrorAction Stop
        $scmPath = Join-Path $scmServiceRoot "$scmName\$scmName.xml"
        $scmOriginal = [IO.File]::ReadAllText($scmPath)
        $scmXml = New-Object Xml.XmlDocument
        $scmXml.PreserveWhitespace = $true
        try { $scmXml.LoadXml($scmOriginal) }
        catch { throw "服务配置 XML 格式错误：$scmPath 。所有 <env> 必须放在 <service> 与 </service> 之间。请修复后重新运行；服务尚未重启。" }
        Set-ProxyEnvironment $scmXml
        $scmPlans += [pscustomobject]@{ path = $scmPath; document = $scmXml; original = $scmOriginal }
    }

    $scmListeners = @(Get-TunnelListener)
    if ($scmListeners.Count -gt 0) {
        Assert-ExpectedTunnel $scmListeners $scmSettings
        Write-Host '复用已存在的本机 SSH 隧道。'
    } else {
        $scmTunnelArguments = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -ConfigPath `"$ConfigPath`" -TunnelOnly"
        # A visible console is required for interactive SSH password / host fingerprint entry.
        $scmTunnelProcess = Start-Process powershell.exe -WindowStyle Normal -ArgumentList $scmTunnelArguments -PassThru
        Write-Host '已打开 SSH 登录窗口。请完成登录；等待隧道建立（最多 120 秒）…'
        $scmDeadline = [DateTime]::UtcNow.AddSeconds(120)
        do {
            if ($scmTunnelProcess.HasExited) { throw 'SSH 登录窗口已退出，隧道未建立。' }
            $scmListeners = @(Get-TunnelListener)
            if ($scmListeners.Count -gt 0) { break }
            Start-Sleep -Milliseconds 500
        } while ([DateTime]::UtcNow -lt $scmDeadline)
        if ($scmListeners.Count -eq 0) { throw '等待隧道超时。请查看 SSH 窗口；完成登录后可以重新运行主脚本。' }
        Assert-ExpectedTunnel $scmListeners $scmSettings
    }

    Write-Host '正在验证代理出口…'
    $scmExitAddress = Get-ProxyExitAddress
    Write-Host "代理出口 IP：$scmExitAddress"
    Write-Host '请确保此 IP 已加入领星白名单。'

    $scmStamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
    $scmWritten = @()
    try {
        foreach ($scmPlan in $scmPlans) {
            Copy-Item -LiteralPath $scmPlan.path -Destination "$($scmPlan.path).$scmStamp.bak" -ErrorAction Stop
            $scmWritten += $scmPlan
            $scmPlan.document.Save($scmPlan.path)
        }
    } catch {
        foreach ($scmPlan in $scmWritten) { [IO.File]::WriteAllText($scmPlan.path, $scmPlan.original, (New-Object Text.UTF8Encoding $false)) }
        throw '更新服务配置失败，已尝试还原本次写入；服务尚未重启。'
    }
    Write-Host '服务 XML 已备份并配置代理，正在重启 API / Worker…'
    Restart-ProxyServices $scmServices

    $scmHealthy = $false
    for ($scmAttempt = 0; $scmAttempt -lt 20; $scmAttempt++) {
        try {
            $scmHealth = Invoke-RestMethod -Uri 'http://127.0.0.1:3001/api/v1/health' -TimeoutSec 3
            if ($scmHealth.status -eq 'ok' -and $scmHealth.database -eq 'ok' -and $scmHealth.worker -eq 'ok') { $scmHealthy = $true; break }
        } catch { }
        Start-Sleep -Seconds 2
    }
    if (-not $scmHealthy) { throw '代理已配置，但 API / 数据库 / Worker 未全部就绪。请检查本机服务日志；本次 XML 备份已保留。' }
    $null = Get-ProxyExitAddress
    Write-Host ''
    Write-Host '启动完成：SSH 代理出口可用，API、数据库和 Worker 健康检查通过。' -ForegroundColor Green
    Write-Host '请保持 SSH 窗口打开，然后在系统中执行店铺同步 / 重试资料补全。'
    Write-Host '出口检查不代表领星鉴权已通过；本脚本未调用领星或修改 ERP 业务数据。'
    Write-Host '当前代理作用于 API / Worker 的 Node 环境代理请求，并非仅领星专用代理。'
} catch {
    Write-Host "启动失败：$($_.Exception.Message)" -ForegroundColor Red
    if (-not $NoPause) { $null = Read-Host '按回车关闭' }
    exit 1
}
if (-not $NoPause) { $null = Read-Host '按回车关闭此窗口（SSH 隧道窗口请保留）' }
