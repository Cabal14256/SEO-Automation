# VPS 与 1Panel 部署说明

核对日期：2026-10-26。当前已在 Ubuntu 24.04、Node.js 24.22.1、PostgreSQL 18.6 上完成 IP HTTPS 试用，API、Worker 使用 1Panel 创建的两项 Node.js 容器，PostgreSQL 也已迁入应用商店创建的实例并登记应用数据库。数据库迁移前后 93 张表的所有者、行数与内容哈希一致；前端、登录、新后台任务、共享文件权限、两项 Node 面板重启和数据库备份恢复已验证。本文仍按通用域名部署说明；整机重启后的完整恢复、正式业务签收和异机灾难恢复尚待验证。现场地址、凭据与备份仅保存在私有交接资料中。

## 1. 当前运行结构

可以部署到 VPS，由 1Panel 管理网站入口、数据库、证书和进程。当前应用必须同时运行 **API 和独立 Worker**，并连接 **PostgreSQL**、共同访问 **业务文件目录 `DATA_DIR`**。API 已能提供前端构建文件，不需要另外运行 Vite 开发服务器。

```text
用户浏览器
    │ HTTPS，443
    ▼
1Panel 管理的 OpenResty
    │ 反向代理
    ▼
API 容器：127.0.0.1:13101 → 3101 ── 前端 apps/web/dist
    │
    ├── PostgreSQL 18 ◀──── Worker：后台导入、同步、导出
    │                           │
    └──────── DATA_DIR ──────────┘
```

| 服务 | 1Panel 管理入口 | 用途 |
| --- | --- | --- |
| `scm-api` | 网站 → 运行环境 → Node.js | 页面、API、文件下载 |
| `scm-worker` | 网站 → 运行环境 → Node.js | 后台处理任务 |
| `scm-postgresql` | 应用商店 → 已安装；数据库 → PostgreSQL | 数据库与队列 |
| OpenResty | 网站 | HTTPS 和统一入口 |

Node.js 运行环境直接使用面板提供的 Node 镜像和完整离线发布目录，分别管理 API、Worker。当前 VPS 只保留这套容器部署方法。

## 2. 准备 VPS、域名与运行环境

小规模内部试用可先按 **2 核 CPU、4 GB 内存、40 GB 以上 SSD** 估算；这是起步建议，尚无本项目容量压测依据。数据库、原始响应、图片、导出文件和备份会持续占用空间，实际容量应按业务量和保留周期调整。

已有其他业务的 VPS 应检查实际可用内存和剩余磁盘。试用中资源紧张的服务器曾在依赖安装阶段失去响应，不能只看总内存或依靠 Node 的堆上限约束包管理器。应先在构建机准备构建产物及适合目标 Linux 的生产运行依赖，再上传校验、解压和迁移；为部署命令和常驻进程设置系统级资源上限。该次试用最终使用经核验无原生模块和符号链接的纯 JavaScript 依赖包，避免在目标 VPS 执行在线安装。

1. 使用 1Panel 当前支持的 Linux 发行版，完成 1Panel 安装。
2. 准备自己的域名，例如 `scm.example.com`，把 DNS 指向 VPS。
3. 在安全组及防火墙放行业务网站的 80/443；SSH 和面板端口限定管理来源。数据库和 API 不向公网发布。
4. 在 1Panel 应用商店安装 OpenResty、PostgreSQL 18。
5. 在面板确认能选择符合以下要求的 Node 镜像；构建机另备对应 Node、Corepack 和 pnpm。

| 依赖 | 当前仓库要求 |
| --- | --- |
| Node.js | `>=24.22.1 <25`，`.node-version` 为 `24.22.1` |
| pnpm | `12.11.2`，由根目录 `packageManager` 固定 |
| Corepack | 本地维护文档当前使用 `0.36.0` |
| PostgreSQL | 18；本地维护文档当前记录 18.6 |

以构建机和目标容器的实际执行结果确认 Node 版本；容器可在面板终端运行：

```bash
node --version
```

不要仅凭 1Panel 列表中的“Node 24”判断符合要求，具体补丁版本仍可能低于仓库下限。容器内只运行预构建产物时，不需要执行 Corepack/pnpm；这些工具用于构建机的依赖安装与构建，在构建机另用 `corepack --version` 核对。构建工具从官方渠道获取，并核验架构和发布校验值。

## 3. 建数据库和独立数据目录

先在 **“应用商店 → PostgreSQL”** 安装实例，等待安装完成、容器健康且数据库可连接，再进入 **“数据库 → PostgreSQL”** 选择该实例创建数据库。数据库和应用用户通过面板创建后，再初始化或恢复原数据。

在数据库页面创建：

- 数据库：`scm_automation`。
- 应用用户：`scm_app`，设置独立随机密码。
- 该用户拥有目标数据库和迁移所需的对象创建权限，供 Drizzle 迁移及 pg-boss 创建队列表使用；日常应用不使用数据库超级用户。以管理员执行 `ALTER DATABASE scm_automation OWNER TO scm_app;` 核对并设置数据库所有者。
- Node 容器连接数据库时，使用共同 Docker 网络中的数据库别名和容器内端口 `5432`，例如 `scm-postgres-panel:5432`。不要填写容器自身的 `127.0.0.1`；第 6 节说明网络设置。

数据库容器内部名称、内部地址和宿主机地址不能混用。见 [1Panel 官方 PostgreSQL 说明](https://proxy2.1panel.cn/docs/v2/user_manual/databases/postgresql/)。

PostgreSQL 18 的数据卷根目录为 **`/var/lib/postgresql`**，应保留当前版本应用模板的挂载结构。新实例使用独立的新数据目录，以逻辑备份恢复；不要把旧集群目录同时挂给两个数据库容器。资源紧张时，在应用的高级配置中设置 CPU、内存和日志轮转，并把 Node 使用的共享网络写入持久 Compose。面板会生成部分资源字段，避免另设与 `deploy.resources.limits` 数值不一致的同类限制；保存后检查 Compose 和容器实际配置。

下面是建议布局，可按实际服务器调整：

```text
/opt/scm-automation/releases/<版本>/     完整发布目录，代码只读
/opt/scm-automation/current             指向选定版本的符号链接
/srv/scm-automation/config/             私有运行配置
/srv/scm-automation/data/                DATA_DIR，业务原件与生成文件
容器日志                              由 Docker 与 1Panel 查看和轮转
```

创建专用 Linux 服务账户，例如 `scm`，让其能读取项目、配置、前端构建文件，并读写业务目录。记录 `id -u scm` 和 `id -g scm` 的数字；API、Worker 容器都使用这组 UID/GID，确保能读取已有的私有文件。`.env` 仅授予所需账户读取权限，例如所有者为 `scm`、权限 `600`；数据目录不放入网站公开目录。发布目录由部署账户持有，运行账户只有读取和目录遍历权限。

`DATA_DIR` 必须是绝对路径。除仓库内规定的开发目录外，配置会拒绝与源码重叠的业务目录，因此生产建议使用上面的 `/srv/scm-automation/data`。

## 4. 上传发布产物并配置环境

在构建机按锁文件安装、构建，再上传受控发布包到 `/opt/scm-automation/releases/<版本>`。不要直接把未经核验的 Windows `node_modules` 当作 Linux 运行依赖；优先在与目标架构、Node 版本匹配的 Linux 环境准备生产依赖。只有核验依赖全为可移植纯 JavaScript、没有原生二进制和失效符号链接时，才可使用对应离线产物。业务数据迁移另按第 9 节进行，不把本机 `.local`、真实 `.env`、业务样例或数据库目录混入源码发布包。

发布包需保留完整目录关系，至少包含 `apps/server/dist`、服务器生产依赖及可解析的 `@scm/contracts`、`apps/server/drizzle`、`apps/web/dist`。仅上传前端 `dist` 或服务器单个 `dist` 都不够。校验压缩包哈希、剩余磁盘和解压后的权限后，再选用该版本。第 6 节使用固定版本目录挂载，避免仅切换宿主机符号链接却误以为已更新容器。

以 `apps/server/.env.example` 为模板，在私有目录创建 `/srv/scm-automation/config/server-container.env`。发布目录的 `apps/server/.env` 链接到容器内 `/srv/scm-automation/config/server.env`；第 6 节将该私有文件只读挂载到这个容器目标。

```dotenv
NODE_ENV=production
DATABASE_URL=postgresql://scm_app:REPLACE_WITH_URL_ENCODED_PASSWORD@scm-postgres-panel:5432/scm_automation
BETTER_AUTH_SECRET=REPLACE_WITH_RANDOM_SECRET_AT_LEAST_32_CHARACTERS
BETTER_AUTH_URL=https://scm.example.com
WEB_ORIGIN=https://scm.example.com
HOST=0.0.0.0
PORT=3101
DATA_DIR=/data
WEB_DIST_DIR=/app/apps/web/dist
LINGXING_REQUESTS_ENABLED=false
LINGXING_TIMEOUT_MS=30000
```

- 全部示例域名、密码和路径都要替换；数据库密码包含 URL 特殊字符时要百分号编码。
- `BETTER_AUTH_URL`、`WEB_ORIGIN` 都填写用户访问的 HTTPS 同源地址，不填写内部 3101 端口或 `/api/v1/auth` 路径。
- 首次部署、恢复和离线验证先保持 `LINGXING_REQUESTS_ENABLED=false`。应用工作正常且已确认授权和接口预算后，再配置领星凭据并显式启用请求。
- `LINGXING_ENV_FILE` 如需使用，改为 Linux 上的私有绝对路径。凭据只放服务器配置，不放前端或截图。
- 全新环境生成新的认证密钥；迁移已有数据时保留原密钥的受控副本，因为已有领星令牌缓存使用该密钥加密。

认证密钥可在服务器生成后通过私有编辑器保存；以下命令输出的是新生成的秘密，不应复制到聊天或公开日志：

```bash
node -e "process.stdout.write(require('node:crypto').randomBytes(48).toString('base64url'))"
```

## 5. 安装、构建、迁移与创建管理员

以下安装、构建命令在构建机的项目根目录执行。暂保留开发依赖，构建、迁移和管理员 CLI 需要相应工具。资源紧张的 VPS 使用前述离线发布方式，不在面板创建容器时自动安装依赖，也不直接在 VPS 执行整仓库构建。

```bash
# 进入构建机上的受控源码根目录。
corepack pnpm install --frozen-lockfile
corepack pnpm build
```

迁移及首次管理员创建必须针对目标数据库受控执行一次。下面的 pnpm 命令需要包含源码、`tsx` 和管理员 CLI 的项目维护工具环境；仅包含生产依赖的离线运行目录不能直接代替它。在维护工具环境的项目根目录、正确配置目标 `.env` 后执行：

```bash
corepack pnpm db:migrate
corepack pnpm --filter @scm/server admin:create --email ops@example.com --name 管理员 --role admin
```

管理员邮箱替换为实际值，密码通过 CLI 交互输入，至少 12 位；不把密码放进命令行参数。系统目前仅支持管理员账户，公开注册关闭，暂不提供普通操作员角色隔离。

已有数据库迁移不需要重新创建原管理员。应用所有待执行的 Drizzle 迁移，不以历史文档中的某个迁移编号作为终止版本。

## 6. 用 1Panel 创建 Node.js 容器

### 准备共享网络和容器配置

在“容器 → 网络”创建专用 bridge 网络，例如 `scm-runtime`，让 PostgreSQL 和两个 Node 容器加入此网络，并为数据库设置网络别名 `scm-postgres-panel`。已运行的 PostgreSQL 可以先附加网络，不必更换数据库或搬迁数据；同时把网络及别名写入数据库对应的持久编排配置或受控重建脚本，防止数据库重建后丢失连接。保留其他业务依赖的原有网络。

使用第 4 节的容器配置，所有者 UID/GID 与运行账户一致，权限 `600`。发布目录的 `apps/server/.env` 链接到容器内的 `/srv/scm-automation/config/server.env`，由只读挂载提供内容。API、Worker 在 `/app/apps/server` 启动时读取同一份配置，宿主机不需要另一份同名应用配置。

### 分别创建两项运行环境

进入 **“网站 → 运行环境 → Node.js → 创建”**，依次创建下表两项；等待前一项创建完成后再建下一项。

| 设置 | API | Worker |
| --- | --- | --- |
| 名称及容器名 | `scm-api` | `scm-worker` |
| Node 版本 | `24.22.1`，以容器内实际版本复核 | 同 API |
| 项目目录 | `/opt/scm-automation/releases/<版本>` | 同 API，挂载完整发布目录 |
| 启动方式 | 自定义命令 | 自定义命令 |
| 安装依赖 | **关闭**（API 字段 `install:false`） | **关闭** |
| 清理现有依赖 | 关闭 | 关闭 |
| 端口映射 | **`127.0.0.1:13101 → 3101/tcp`** | **不设置端口** |
| 初次暂存命令 | `exec sleep infinity` | `exec sleep infinity` |
| 实际启动命令 | `cd /app/apps/server && exec node --max-old-space-size=128 dist/api.js` | `cd /app/apps/server && exec node --max-old-space-size=192 dist/worker.js` |

暂存命令用于先完成权限、网络、初始化和资源限制，确保准备完成后再处理任务。纯 JavaScript 运行依赖已经随发布包提供，面板里的包管理器选项无需承担安装任务。

面板创建或编辑会异步重建容器。提交后等待重建日志完成，再核对容器 ID、启动时间和实际进程命令；旧容器仍在运行时，列表短暂显示“已启动”不能证明新命令已生效。当前操作完成前不要再次提交编辑、启动或重启，以免 Compose 操作并发。

两项环境都设置 `NODE_ENV=production`、`TZ=Asia/Shanghai`、`HOME=/tmp`，并补充以下挂载：

| 宿主机源 | 容器目标 | 权限 |
| --- | --- | --- |
| 完整固定版本发布目录 | `/app`，通常由面板自动生成 | 只读；检查自动挂载，避免重复目标 |
| `/srv/scm-automation/data` | `/data` | 读写 |
| `/srv/scm-automation/config/server-container.env` | `/srv/scm-automation/config/server.env` | 只读 |

**不要只把 `apps/server` 挂到 `/app`。** 当前配置会根据服务器构建文件推导项目根目录，完整发布目录可以同时保留配置路径、共享包、前端资源和业务目录边界。容器内的 `DATA_DIR=/data` 在代码树之外，且 API 与 Worker 必须访问同一个宿主机数据目录。

### 设置权限与资源限制

在真正运行应用前，检查两项运行环境生成的 Compose 文件。标准安装通常在 `/opt/1panel/runtime/node/<运行环境名称>/docker-compose.yml`；以面板实际安装目录为准。先保留面板生成的镜像、启动脚本、环境文件和已有配置备份，再将 `node` 服务调整为：

- `user` 使用前面记录的 `scm` 数字 UID/GID；两项完全一致。面板的启动脚本需可读取和执行，模板参数文件需可读取，私有业务配置仍保持 `600`。
- 接入持久声明为 `external: true` 的 `scm-runtime` 网络；确认能解析并连接数据库别名。
- API 设置 `mem_limit: 256m`、`memswap_limit: 384m`；Worker 设置 `mem_limit: 320m`、`memswap_limit: 448m`；两者可先设置 `cpus: 0.75`、`pids_limit: 128`。这是小规模试用起点，需根据真实任务峰值调整。
- 设置 `restart: unless-stopped`、`stop_grace_period: 45s`，让退出和重建过程给在途任务留出清理时间。
- 设置 `read_only: true`、`cap_drop: [ALL]`、`security_opt: [no-new-privileges:true]`；为 `/tmp` 提供可写 tmpfs，例如 `64m`。`HOME=/tmp` 让面板启动脚本的 npm 配置写入临时目录。
- 设置日志轮转，例如 `json-file` 的 `max-size: 10m`、`max-file: "3"`。发布目录由部署账户持有，运行 UID 不可写入代码。

保存后先运行 `docker compose config --quiet` 检查语法，再通过面板启动或重启。**仅使用 `docker update` 设置限制不会让它们随面板重建持久保留。** 当前面板在编辑运行环境时会重新生成部分字段，特别是 `/app` 挂载可能恢复为读写；每次面板编辑、切换版本或升级模板后，都要复核磁盘上的 Compose 和 `docker inspect` 的有效用户、内存、网络及挂载。代码目录的宿主机权限也应始终阻止运行账户写入。

### 启动和检查

首次部署应先完成数据库迁移和管理员创建，再把 API 改为实际启动命令；确认日志显示队列准备完成，再启动 Worker。迁移可在暂存 API 容器内执行 `docker exec -w /app/apps/server scm-api node dist/db/migrate.js`，管理员创建仍使用第 5 节的受控维护工具环境。不要为了补齐管理员 CLI，在资源紧张的生产容器临时安装整套开发依赖。API 启动后只在宿主机内检查：

```bash
curl --fail http://127.0.0.1:13101/api/v1/health
docker inspect --format 'user={{.Config.User}} memory={{.HostConfig.Memory}} restart={{.HostConfig.RestartPolicy.Name}}' scm-api scm-worker
docker port scm-api
docker port scm-worker
```

API 应仅有回环映射，Worker 没有端口输出。健康响应中 `database`、`worker` 都应为 `ok`；还需确认新 Worker 启动后产生了新心跳，并提交一项新的后台任务验证执行完成。前端由 API 提供，无需创建第三个 Node 进程或运行 Vite。以后可直接在 Node.js 列表查看两项日志、停止、启动和重启。

## 7. 创建反向代理网站和 HTTPS

在“网站 → 创建网站”选择**反向代理**，绑定实际域名，将根路径 `/` 转发到 API，保留请求原路径。这样页面、`/api/v1/*` 和文件下载都走同一个域名。见 [1Panel 官方创建网站说明](https://docs.fit2cloud.com/1panel/user_manual/websites/website-create/)。

代理目标为 **`http://127.0.0.1:13101`**，这个回环地址要求 OpenResty 使用宿主机网络。在 1Panel 容器详情核对 OpenResty 网络模式：如果它使用隔离的 bridge 网络，容器中的 `127.0.0.1` 指向该容器，不能访问宿主机回环端口。应先配置明确的私有可达网络，再填写对应上游地址；不要通过向公网开放 API 端口解决网络问题。

在证书页面申请或导入域名对应证书，然后在网站启用 HTTPS 和 HTTP 跳转 HTTPS。证书可从 1Panel 的证书模块选用，见 [官方网站 HTTPS 配置说明](https://docs.fit2cloud.com/en/1panel/user-manual/websites/website-config-basic/)。

检查或按需要调整网站配置：

```nginx
# 在已有 server 配置中调整，不重复创建同名 location。
client_max_body_size 25m;

# 在现有反代 location 中确认这些头及合理的超时。
proxy_set_header Host $host;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_read_timeout 120s;
```

25 MiB 是反代请求体上限建议：原始导入文件上限为 10 MiB，草稿 JSON 请求体上限为 20 MiB，Base64 编码会膨胀。应用自身仍按各接口规则限制请求，不因反代设为 25 MiB 放宽业务文件限制。

不要启用会缓存认证/API 响应的整站缓存。保存配置后测试并重载 OpenResty。

## 8. 上线检查

1. 外部浏览器通过实际 HTTPS 域名访问，证书可信，登录成功。
2. `/api/v1/health` 中数据库、Worker 都为 `ok`；看得到 API 和 Worker 各自的日志。
3. 使用虚构样例测试导入、保存草稿、后台处理、单据生成、下载与刷新后恢复，确认任务真正执行完成。
4. 关闭浏览器后重新登录，刷新功能子路径，确认前端静态文件和 SPA 回退正常。
5. 确认“领星单据与分配”“物流与交接”“报关与 9810”“批次归档”四项显示维护状态。
6. 在维护窗口重启 VPS，确认数据库、API、Worker、OpenResty 自动恢复，并再次检查 Worker 新心跳。检查 Docker 的启动及三项容器的重启策略。
7. 从另一台设备验证数据库和 API 端口不可直接通过公网访问。
8. 完成一次独立环境的数据恢复验证后，再作为正式运行环境交付。

如使用领星接口，从 VPS 出口地址检查第三方账号权限、IP 限制和网络连通性。访问其他在线表格、产品图片等来源时，也应在 VPS 上实际验证；本地成功不代表 VPS 能访问。

## 9. 升级、备份与恢复

### 日常备份

**1Panel 的数据库备份不包含 `DATA_DIR`，网站目录备份也不自动覆盖仓库外的业务数据目录。** 完整备份至少包含：

- PostgreSQL 全部应用表与队列表的逻辑备份。
- 同一恢复点的完整 `DATA_DIR`，包括原件、图片、导出文件和模板版本。
- 私有运行配置、原认证密钥及必要凭据的加密副本。
- Node、PostgreSQL 的容器定义和网站、证书配置。
- 对应应用版本、离线运行依赖、锁文件、Drizzle 迁移及规则文档。

最容易核对一致性的初版方法：维护窗口停止 API/Worker，在停止状态下完成数据库备份与目录归档，确认两部分都完成后再启动。数据库可以由 1Panel 执行备份，业务目录另行归档并加密传到独立存储。后续需要每日自动化时，应新增一个协调停止、数据库导出、文件归档、校验、恢复服务和失败告警的 Linux 备份脚本，不能把互不协调的两项计划任务直接称为一致性备份。

至少保留最近 30 天每日备份，并按业务需要增加月备份；每月在独立环境恢复抽查账号、文件哈希、历史导出和任务记录。VPS 本机上的备份只算暂存，不代替独立介质或异地副本。

当前 `trial:deploy` 调用 PowerShell，`scripts/trial/core.mjs` 的备份恢复还调用 `pg_dump.exe`、`pg_restore.exe` 并依赖 Windows 服务流程，**这些命令不能作为现成 Linux 备份恢复方案直接运行**。

### 数据恢复

使用对应版本的 PostgreSQL 和应用发布包建立隔离目标，通过 1Panel 创建同名数据库及应用角色。核对数据库所有者后恢复逻辑备份，再恢复同一恢复点的业务文件、配置及原认证密钥。全局角色 SQL 可能包含初始化集群已存在的默认管理员，应按需要恢复应用角色，避免直接覆盖默认角色。

切换前核对表所有者、行数、内容校验、账号、文件哈希和未决任务。先启动 API，再启动唯一一项 Worker，验证新心跳和新后台任务后恢复入口。不要把已经接收写入的新库直接切回旧备份而丢失新增记录。

### 升级和回退

1. 升级前记录版本、备份数据库与完整业务目录，确认可恢复。
2. 先在构建机准备指定版本及锁定依赖的离线发布包；在维护窗口停止 API/Worker，上传校验并执行所有待执行迁移，不在资源紧张的生产 VPS 临时安装和构建。
3. 更新两项运行环境的固定版本源目录，容器内 `WEB_DIST_DIR=/app/apps/web/dist` 保持稳定，并复核面板重建后的资源限制及挂载。启动并验证数据库、Worker、页面、登录及导出。
4. 只涉及代码且数据库兼容时可切回上一代码版本；涉及不兼容迁移时，代码回退不会撤销数据库变化，应在独立环境恢复升级前完整备份，再核对切换。
