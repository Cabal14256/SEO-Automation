# 开发机通过 Ubuntu 固定出口访问领星

## 当前 Windows 服务环境的一键启动

云端按本文安装 Tinyproxy 后，在项目根目录双击 `启动领星代理.cmd`。接受 Windows 管理员权限提示后，首次输入服务器 IPv4 / 域名、SSH 端口和 Ubuntu 用户名。配置保存在忽略提交的 `.local/lingxing-proxy.local.json`，不保存密码或私钥。SSH 使用当前管理员账户的 OpenSSH 认证配置；如需密码，在新打开的 SSH 窗口输入，并在首次连接时核对服务器指纹。

脚本会复用匹配的本机 SSH 隧道，验证出口 IP，备份并更新 `D:/SCM-Automation/.local/development/services` 中 API / Worker 的 WinSW XML，然后重启 `SCM-Local-API`、`SCM-Local-Worker` 并等待健康检查。重启时先停止正在运行的依赖服务（例如 `SCM-Local-Web`），再按依赖顺序启动；原本停止的依赖服务保持停止。其他程序占用 18888 或出口检查失败时，不修改服务配置。关闭 SSH 窗口会断开代理；再次双击可重新建立。Ubuntu SSH 需允许 TCP 转发。此脚本不安装云端 Tinyproxy、不修改领星白名单、不验证领星鉴权，也不操作 ERP 业务数据。

这套启动配置作用于 API / Worker 支持 Node 环境代理的外部请求，本地 HTTP 请求直连，尚不是领星专用客户端代理。Windows 服务环境请使用此入口，无需执行下文的 `runtime.ps1 app-restart`；下文该命令适用于手动进程运行方式。

重新填写服务器信息：

```powershell
.\scripts\lingxing\start-proxy.ps1 -Configure
```

离线检查（不连接 SSH、不改服务）：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/lingxing/start-proxy.test.ps1
```

需要恢复旧服务配置时，从对应服务目录中选择本脚本运行前的 `.xml.时间戳.bak`，复制回同名 `.xml` 后重启对应服务。脚本不会自动清除旧备份。

适用环境：Windows 开发机、Ubuntu 云服务器和 1Panel。开发机继续运行 API、Worker、数据库及文件存储；云服务器提供 HTTP 代理出口。本方案尚未在目标云服务器执行。

## IP、用户名和密码填在哪里

| 信息 | 填写位置 |
| --- | --- |
| 云服务器公网 IP、SSH 端口、SSH 用户名 | 下文 Windows PowerShell 的 `$scmCloudAddress`、`$scmSshPort`、`$scmSshUser` |
| Ubuntu 的 SSH 登录密码 | 运行 `ssh` 后，在终端出现 `password:` 时输入；输入不会回显 |
| 1Panel 登录密码 | 仅用于登录 1Panel；建立隧道使用 Ubuntu 的 SSH 认证 |
| 项目代理地址 | 本机 `http://127.0.0.1:18888`，由 SSH 隧道转发到云端代理 |
| 领星 IP 白名单 | 云服务器实际访问领星时使用的固定公网出口 IP |

SSH 密码不写入项目 `.env`、命令参数或聊天。下面的 SSH 隧道负责认证和加密，HTTP 代理仅允许服务器本机连接。

## 1. 在 1Panel 终端安装云端代理

进入 1Panel 的“终端”（部分版本位于“主机 → 终端”），连接当前 Ubuntu 主机。若面板要求填写终端连接信息，使用该服务器的 SSH 地址、端口、系统用户名及系统密码。

以下命令适用于尚未搭建 Tinyproxy 的服务器：

```bash
sudo apt-get update
sudo apt-get install -y tinyproxy
sudo cp -n /etc/tinyproxy/tinyproxy.conf /etc/tinyproxy/tinyproxy.conf.scm-backup
sudo nano /etc/tinyproxy/tinyproxy.conf
```

在配置文件内找到并修改对应设置，确保同名设置没有重复，保留其他必要默认配置：

```text
Port 18888
Listen 127.0.0.1
Allow 127.0.0.1
ConnectPort 443
```

`Allow` 仅保留本机地址，删除其他网段放行；`ConnectPort` 仅保留 443。保存后启动并检查：

```bash
sudo systemctl enable tinyproxy
sudo systemctl restart tinyproxy
sudo systemctl is-active tinyproxy
sudo ss -lntp 'sport = :18888'
```

预期服务为 `active`，监听地址为 `127.0.0.1:18888`。1Panel 防火墙与云安全组无需开放 18888，隧道使用已有 SSH 端口。

## 2. 在 Windows 填服务器信息并打开隧道

在本机 PowerShell 中填写前三项，然后运行整段命令：

```powershell
$scmCloudAddress = '填写云服务器公网IP或域名'
$scmSshPort = 22
$scmSshUser = '填写Ubuntu的SSH登录用户名'

ssh -N -T -L 127.0.0.1:18888:127.0.0.1:18888 -p $scmSshPort -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 "$scmSshUser@$scmCloudAddress"
```

SSH 端口使用云服务器实际的 SSH 端口。首次连接时，通过云控制台核对主机指纹，再完成确认；随后在 `password:` 提示处输入 Ubuntu SSH 密码。若服务器只允许密钥认证，改用已授权密钥并给 `ssh` 添加 `-i '本机密钥文件路径'`。

成功后终端保持等待是正常现象：`-N` 只建立隧道，不进入远程命令行。开发期间保留这个终端。按 `Ctrl+C` 或关闭窗口会断开隧道；断线后需要重新连接。

## 3. 检查出口并重启本机 API 和 Worker

另开一个 PowerShell 终端，先验证代理出口：

```powershell
curl.exe --silent --show-error --fail --max-time 15 --noproxy localhost,127.0.0.1,::1 --proxy http://127.0.0.1:18888 https://checkip.amazonaws.com
```

将返回的固定出口 IP 加入领星白名单。这个测试只检查出口，不发送领星凭据。

在同一个 PowerShell 终端设置代理环境并重启应用：

```powershell
$env:HTTP_PROXY = 'http://127.0.0.1:18888'
$env:HTTPS_PROXY = 'http://127.0.0.1:18888'
$env:NO_PROXY = 'localhost,127.0.0.1,::1'
$env:NODE_USE_ENV_PROXY = '1'

Set-Location -LiteralPath 'D:\SCM-Automation'
./scripts/m0/runtime.ps1 app-restart
```

现有启动脚本会把这些变量传给 API 和 Worker。Node 在启动时读取代理环境，所以需要重启两个进程；仅把变量追加到应用运行期间加载的 `.env`，不能替代此启动步骤。`NO_PROXY` 保持本地健康检查和本地 HTTP 请求直连。

上面的变量只作用于当前 PowerShell 及其启动的子进程。下次从新终端重启项目时，需要重新执行这段环境设置；隧道也要保持连接。当前步骤未改动全局 Windows 代理或试用环境服务。

最后检查本地服务：

```powershell
Invoke-RestMethod -Uri 'http://127.0.0.1:3001/api/v1/health'
```

应返回数据库与 Worker 为 `ok`。随后进行一次明确的领星查询，才能确认白名单、鉴权及业务接口都已恢复；网络出口测试成功本身不代表领星鉴权通过。

## 停用开发代理

在 PowerShell 清除本次代理变量并重启应用，再关闭 SSH 隧道：

```powershell
Remove-Item Env:HTTP_PROXY,Env:HTTPS_PROXY,Env:NO_PROXY,Env:NODE_USE_ENV_PROXY -ErrorAction SilentlyContinue
Set-Location -LiteralPath 'D:\SCM-Automation'
./scripts/m0/runtime.ps1 app-restart
```

正式迁至 Ubuntu 后，按云服务器实际网络配置出口；开发隧道使用的 `127.0.0.1:18888` 无需保留到容器配置中。
