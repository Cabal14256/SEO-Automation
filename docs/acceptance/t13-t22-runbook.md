# T13 真实增量与 T22 业务批次验收

验收工具读取真实原件及应用已有记录，不创建、修改或清理业务数据，不调用领星。自动对账完成不等于业务签收。正式试用资料、人工参考、对账包与签收原文统一保存在受控的 `D:/SCM-Automation/.local/trial/data/acceptance`，Cookie 单独放在 `D:/SCM-Automation/.local/trial/config`；脱敏汇总才进入版本库。

## 当前可直接执行

先完成工作区构建。默认开发预检使用以下路径，本轮已经生成的预检保留在此处：

```powershell
corepack pnpm build
node scripts/acceptance/cli.mjs prepare --out D:/SCM-Automation/.local/development/data/acceptance
node --test scripts/acceptance/core.test.mjs
```

`prepare` 不覆盖已有清单，每次生成新的预检目录。清单绑定本地私有配置指定的原件及哈希，缺少真实后续文件时输出 `pending`；不得以修改时间冒充实际导出时间。历史证据路径由受控配置提供，技术夹具不计为真实业务样本。

正式试用验收另用试用环境的 `DATA_DIR` 准备资料清单：

```powershell
node scripts/acceptance/cli.mjs prepare --out D:/SCM-Automation/.local/trial/data/acceptance
```

每日完整备份包含试用 `DATA_DIR`；开发目录后续生成的新资料和签收包不会自动同步到试用目录。试用初始化时复制的预检只代表当时快照。正式增量原件、人工预期、参考和签收结论原文也应放入试用 `data/acceptance`，并将清单中的路径指向该处；既有开发预检保持原位。Cookie 不加入验收证据包，只供当前管理员会话的只读采集使用。

## T13 资料与实测

补充受控 `intake-manifest.json`：`initial` 和 `increment` 分别说明文件路径、来源、可核实的 `exportedAt`、`kind`（`snapshot` 完整快照或 `delta` 仅增量）；若不是默认工作表，再填写 `sheetName`、`mappingVersion`。`sellerConfirmations` 每项包含 `sourceShop`、`sid`、`country`、`confirmedBy`、`confirmedAt`，反映本次人工核对，不要求建立永久店铺别名。

`expectedDiff` 指向业务人员独立整理的 JSON 数组，每项为 `{ "sid": 123, "fba": "FBA...", "kind": "new" }`；`changed` 项还须写 `changedFields`。类别支持 `new`、`unchanged`、`changed`、`conflict`、`error`、`missing`，错误身份可使用 `sid: null`。变化字段只比较渠道、目的 FC、参考数量、备注、来源组名，与正式需求预览口径相同。来源名称及来源日期变化不擅自变更首次业务日期。

```powershell
node scripts/acceptance/cli.mjs preflight --manifest D:/SCM-Automation/.local/trial/data/acceptance/intake-manifest.json --out D:/SCM-Automation/.local/trial/data/acceptance/t13-review-001
```

工具复用应用 XLSX 解析器，按确认的 `sid + FBA` 比较，保留重复来源的工作表、物理行及单元格位置。完整快照缺行只提示，当前身份未解决时暂停缺失推断；仅增量不推断缺行。缺值与合法零不合并。

真实管理员通过现有导入页面完成首次和后续导入、店铺确认、差异核对及提交。保留提交前后需求、来源详情、首次提交结果及相同 `operationId` 的重放结果。可将现有 API 响应整理到 `operationEvidence` 指向的 JSON：

| 字段 | 内容 |
| --- | --- |
| `initialCommit`、`incrementCommit`、`replayCommit` | 现有提交接口返回的完整结果 |
| `beforeDemands`、`afterDemands` | 后续提交前、后的完整需求记录数组 |
| `demandDetails` | 关联需求详情数组，含文件、工作表、物理行及店铺确认 |
| `actualPreview` | 本次完整预览 `{preview, items}`，汇集所有分页 |

工具核对幂等返回、需求唯一性、缺行不撤销、首次业务日期/周保持、来源关联及独立差异预期。未提供实测证据时始终待验；未在真实文件出现的类别单列 `uncoveredRealCategories`。发现首次资料的错误或冲突仍须解释并与已接受需求核对，不会自动丢弃错误行。

## T22 只读采集与签收包

先在业务页面建立并保留实际批次，处理差异、确认、编码及导出。不得使用会删除自建测试数据的 `scripts/t12/m2-e2e.mjs` 代替实际批次验收。

填写 `capture.example.json` 的实际批次、组及已完成导出编号，另存 `capture.json`。从当前管理员会话取得 Cookie，仅写入受控私有文本文件，不加入清单或证据包。HTTPS 证书必须已受信任；工具不关闭证书校验。

```powershell
node scripts/acceptance/cli.mjs capture --manifest D:/SCM-Automation/.local/trial/data/acceptance/capture.json --cookie-file D:/SCM-Automation/.local/trial/config/admin-cookie.txt --out D:/SCM-Automation/.local/trial/data/acceptance/batch-capture-001
node scripts/acceptance/cli.mjs batch-package --manifest D:/SCM-Automation/.local/trial/data/acceptance/batch-capture-001/batch-manifest.json --out D:/SCM-Automation/.local/trial/data/acceptance/t22-package-001
```

采集仅 GET 已有批次、组、需求来源、完整分页报表、导出记录及文件；不会提交同步、确认、编码或导出任务。前后复核组内容及导出有效性，过程中版本变化则失败。已有受控 API JSON 也可直接填写 `batch-manifest.example.json`，无需提供 Cookie。

人工参考 JSON 包含 `preparedBy`、`preparedAt`、`source`、`independentlyPrepared: true`，以及 `products`、`boxes` 数组。商品以 `sid/FBA/MSKU/FNSKU/SKU` 为完整身份，逐箱以这些字段加 `boxOrder` 区分；参考中填写 `groupName`、`quantity`、`productName`、`codes`、`groupQuantity`、`monthQuantity`、`businessDate`、`actualShipDate`，逐箱填写 `groupName`、`boxOrder`、`code`、`quantity`。内部箱 UUID 可用于定位，但不要求人工参考从系统回填 UUID。参考数量应来自业务原始资料，不能复制系统结果后声明独立编制。

发生已人工决定的列表申报量差异时，`decisionEvidence` 指向受控 JSON 数组，每项保留 `groupId`、`demandId`、`shipmentVersion`、`issueCode`、`note`、`createdBy`、`createdAt`。现有组详情不暴露全部决定原因，需由业务记录或受控只读查询补充；缺失则待验。

签收包固定有序组、成员、需求及商品箱修订、箱序、规则、确认、编码、导出及模板版本；对比页面、人工参考、XLSX 主表与逐箱明细，检查动态箱列、分配编码、完整组/月数量、日期和数量守恒。输出逐行商品、逐箱 JSON、差异清单、原始输入及 SHA-256 清单。当前新导出已统一采用发布后的冻结流程状态，首次生成即可与页面核对。修复前保留的历史文件仍保持原样，工具如发现历史流程状态差异，会如实列出；应核对历史版本后决定使用哪个文件签收。

## 用户明确签收

只有 `ready_for_signoff` 包才能登记 `accepted`。用户逐行核对后，保留其明确结论原文，填写 `signoff.example.json` 的签收人、时间、结论、包哈希及 `evidencePath`，另存实际决定文件：

```powershell
node scripts/acceptance/cli.mjs verify --package D:/SCM-Automation/.local/trial/data/acceptance/t22-package-001
node scripts/acceptance/cli.mjs signoff --package D:/SCM-Automation/.local/trial/data/acceptance/t22-package-001 --decision D:/SCM-Automation/.local/trial/data/acceptance/signoff-decision.json --out D:/SCM-Automation/.local/trial/data/acceptance/t22-signoff-001
```

签收单独留档，不修改原证据包；缺失、追加或修改证据均使完整性验证失败。记录仅保留明确人工结论与哈希，不冒充电子身份认证或数字签名。`pending`、`rejected` 可留档，但不得据此把 T22 标为完成。

准备工具和恢复测试均不消耗领星业务预算。实际批次如需刷新，仍沿用累计 `78/100`，最多剩余 `22` 次，分页、失败及重试都计数。
