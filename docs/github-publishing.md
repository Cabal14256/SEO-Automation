# 干净根仓库上传 GitHub

在 `SCM-Automation` 根目录维护源码并提交。根目录中的 `.git` 是新的干净历史；`.local` 保存开发与试用数据、原 Git 历史、旧公开快照、恢复副本及迁移恢复点，不属于上传内容。本次目录整理不创建远程仓库，也不执行推送。

## 发布前检查

以下命令在源码根目录执行：

```powershell
corepack pnpm privacy:install-hook
corepack pnpm privacy:test
corepack pnpm path-policy:test
corepack pnpm privacy:check
corepack pnpm privacy:history
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm test
corepack pnpm build
git status --short
git ls-files -ci --exclude-standard
```

全部检查须通过；最后一条命令应无输出。检查暂存区只包含程序、通用文档和虚构示例，不含 `.local`、`.env`、数据库、备份、业务原件、截图或构建输出。模式检查不能识别所有未知业务资料，新增样例仍需确认来源。原 Git 历史及归档只用于本机恢复，不导入当前仓库。

有新修改时，先使用明确路径暂存并核对，再提交：

```powershell
git add -- <本次要提交的源码路径>
git diff --cached --stat
git diff --cached
git commit -m "Describe the source change"
corepack pnpm privacy:history
```

## 由维护者连接并上传

在自己的 GitHub 账号下准备空仓库，仓库可命名为 `SCM-Automation`；创建时不要生成 README、许可证或 `.gitignore`，避免引入另一套初始历史。将下方示例地址替换为实际仓库地址，再执行：

```powershell
git remote -v
git remote add origin https://github.com/<owner>/SCM-Automation.git
git push -u origin main
```

已有 `origin` 时先核对其地址；不要重复添加、覆盖其他仓库或强制推送。首次推送和以后更新均来自这个根仓库，GitHub 中直接呈现 `apps`、`packages`、`docs`、`scripts` 等源码目录，不包含本机私有子目录，也不需要 `public` 副本。

推送前钩子会再次检查全部历史；GitHub 工作流也执行隐私检查。首次上传后核对文件列表和检查结果。新设备克隆后按 README 安装依赖、安装本地钩子，并分别准备私有配置和数据库；GitHub 源码不能恢复本机业务数据。
