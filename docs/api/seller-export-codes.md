# 店铺导出代号

设置入口：`/settings/seller-export-codes`。仅有效管理员可读写。配置绑定店铺 SID，数字代号按字符串保存（最多 20 位，支持前导零）；空字符串恢复店铺名称。店铺来源同步及切换不覆盖配置。

- `GET /api/v1/seller-mappings/export-codes`：返回 `{items:[{sid,name,country,code,version}]}`；未配置时 `code=""`、`version=0`。
- `POST /api/v1/seller-mappings/export-codes/:sid`：提交 `{operationId,expectedVersion,code}`，返回 `{code,version}`。校验数字格式、管理员权限及来源；版本冲突返回 409。原操作编号和相同内容重试返回原结果；同编号不同内容返回操作冲突。每次修改记录操作者和修改前后代号。

单票发票与整批压缩包新文件生成时读取配置，只替换文件名中的店铺部分。未配置或清空时使用单据快照中的店铺名，不修改店铺资料、单据内容或领星数据。历史下载使用已归档文件名；整批复用已生成的单票时保留归档名称，包内重名仍添加序号。

数据库迁移：`0025_pink_jack_flag.sql`。

验证：`node scripts/settings/seller-export-codes-db.mjs` 使用独立 PostgreSQL 实例验证迁移、持久化、幂等、并发冲突、权限和审计；`node scripts/settings/seller-export-codes-browser.mjs` 使用离线 API 验证保存、清空、搜索、失败重试及桌面/手机布局，不调用真实领星。
