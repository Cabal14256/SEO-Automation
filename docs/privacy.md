# 隐私检查与公开发布

公开版本只包含程序、通用规则、空白模板和独立编造的示例。公司及店铺名称、实际 SID、FBA、SKU、FNSKU、订单、联系人、地址、税号、银行信息、凭据、原始响应、截图和业务备份均属于受控数据。移除直接名称后，还需要检查文件名、哈希、批次明细及解压文件是否能关联原始业务。

真实资料存放在受控私有 `DATA_DIR` 或被忽略的本地目录。`docs/private`、`docs/research` 和 `docs/acceptance/evidence` 除各自的说明外不发布；`.env`、`.local`、运行数据、构建输出和发布包不作为源码上传。公开示例使用 `EXAMPLE-DE`、`EXAMPLE-US` 等虚构名称，不能从实际店铺列表批量替换名称后保留真实商品和交易明细。

运行以下命令检查当前允许提交的文件、根仓库全部历史和检查器自身：

```powershell
corepack pnpm privacy:check
corepack pnpm privacy:history
corepack pnpm privacy:test
corepack pnpm privacy:install-hook
```

`privacy:install-hook` 为当前根仓库安装本地推送前检查；新克隆须再次执行安装命令。检查器用于识别已知风险模式和本地私有标识，无法自动理解所有新的业务字段。新增测试夹具应从空白编造，业务验收的结果和截图保持私有。检查输出也不要包含原始敏感值。

整理后的 `SCM-Automation` 根目录是唯一长期维护和发布的源码仓库，直接从该目录提交和上传。`.local/development`、`.local/trial`、`.local/archive`、`.local/migration` 以及其他 `.local` 内容一律不提交。原 Git 历史包含真实资料，已单独保留为本机恢复资料；根仓库采用新历史，不复制或合并旧 `.git`、分支、标签。旧公开目录仅是历史快照，归档后不再作为第二套开发代码。操作步骤见 [GitHub 发布](./github-publishing.md)。

旧 Git 提交曾包含真实资料时，仅编辑工作区、删除文件或配置忽略规则都不会移除旧提交。其他仍保留旧历史的副本应先进行同样的受控归档和新历史迁移，不可直接推送。

需要独立快照时仍可使用可选导出工具，输出必须是源码仓库之外的新目录，且其父目录已存在：

```powershell
corepack pnpm privacy:export --out C:/Temp/SCM-Public-Export
```

该可选流程检查允许发布的当前文件并建立独立的一次初始提交，不配置远端或推送，不改变根仓库。它拒绝已有目标及仓库内目标；不能将 `.local/public` 作为导出位置。日常发布仍从根仓库进行，不需要重新导出。

脱敏前原件已另行私有备份；原件与历史验收结论继续保留在本地，公开示例不冒充历史业务证据。

## 私有导入验收配置

涉及真实参考原件的本地验收脚本通过 `IMPORT_ACCEPTANCE_CONFIG` 读取受控 JSON。字段示例见 [`scripts/shared/acceptance-fixture.example.json`](../scripts/shared/acceptance-fixture.example.json)，该文件只包含虚构值，不能直接当作真实验收证据。

```powershell
$env:IMPORT_ACCEPTANCE_CONFIG = 'D:/SCM-Automation/.local/development/config/import-acceptance.local.json'
```

配置可指定来源文件和哈希、预期行分类、店铺选择、优先货件、快照目录及本地状态预期。真实值只保存在项目外或被忽略的 `.local/` 中；使用示例结构建立本地配置后，指向实际存在的受控文件。验收报告、原始响应和截图继续保持私有，配置文件不要提交或复制到公开导出目录。
