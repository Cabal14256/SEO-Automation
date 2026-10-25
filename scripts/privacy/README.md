# 公开源码检查与导出

```powershell
node scripts/privacy/check.mjs
node scripts/privacy/check.mjs --history
node --test scripts/privacy/core.test.mjs
node scripts/privacy/install-hook.mjs
```

检查包含 Git 已跟踪的文件，以及未被忽略的新文件。已被 `.gitignore` 覆盖但仍被跟踪的文件也会阻止检查通过；忽略规则不会从现有提交中删除文件。`--history` 另外检查所有 Git 引用可达的文件内容、文件名和提交信息。检查只输出规则、行号和位置，匹配敏感信息的文件名会被隐藏。

`docs/private/` 是本地业务示例目录，整个目录（包括 README）都必须保持未跟踪；检查器拒绝当前树中该目录下的任何文件，导出器也不会复制它们。用 `git ls-files -- docs/private` 核对，结果应为空。`.gitignore` 不会取消既有跟踪，需要时用 `git rm --cached -- <具体文件>` 保留本地原件并取消跟踪。

历史检查仅兼容此前已公开、已审阅的通用目录说明：精确路径 `docs/private/README.md` 和固定 blob `a037a5d4f8cc0287d94d0c3b6312632cfe215409` 同时匹配，且内容仍执行常规敏感扫描。此兼容不适用于当前工作区、导出、新增或改写的私有 README，也不允许其他私有文件进入历史。取消跟踪不会清除旧提交。

公开源码只保留明确虚构的测试、示例与通用业务规则。真实业务原件、调研、验收证据、截图、运行数据、凭据与二进制文档应留在受控本地目录。FBA 示例使用 `FBADEMO` 或 `FBATEST` 前缀；ASIN 示例使用 `B0TEST0001` 一类明确虚构的编号。新增的真实店铺名、SKU、SID 等应加入被忽略的 `.local/privacy/known-values.json`，格式为 `{"format":"scm-private-values/v1","values":["需要阻止公开的完整标识"]}`。此清单只用于本地检查，不会导出。

根仓库完成旧历史归档和新历史迁移后，日常发布直接使用根仓库，不维护第二套公开源码。原 Git 历史、旧公开快照和迁移恢复资料只保存在被忽略的 `.local` 中，不能合并或推送旧历史。详细步骤见 [GitHub 发布](../../docs/publishing/github-publishing.md)。

`node scripts/privacy/export.mjs --out C:/Temp/SCM-Public-Export` 仅作为可选独立快照工具，要求父目录已存在且目标是项目外的新目录。它拒绝已有目标和仓库内目标，复制当前 Git 可见且允许公开的文件，包含尚未提交的代码；复制前后检查，再创建独立的一次初始提交并安装推送前检查，不配置远程仓库。该工具不改变根仓库，日常更新无需导出。

推送前钩子和 GitHub 工作流都会检查历史。钩子是本地防护；克隆者可运行安装命令启用。模式检查无法自动识别所有真实公司资料，新增测试样例仍需人工确认来源与虚构性。
