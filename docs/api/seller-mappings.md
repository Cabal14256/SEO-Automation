# 店铺映射接口

## 领星自动批准与本地别名维护（2026-10-18）

领星目录中有效授权店铺自动批准：授权状态为`1`、仍在当前目录、身份资料完整，且已通过可信缓存迁移或显式目录同步获得自动批准标记。管理员无需逐店批准。数据库以`lingxing_auto_approved`和`lingxing_disabled`分别保存领星自动批准与本地停用，原`status`只维护人工资料；列表及查询返回当前来源的有效`status`，不会通过GET修补数据库或发起外部请求。

管理员可在领星目录行点击“维护别名”，在原生小窗口维护本系统的需求别名、本地停用/恢复及原因，并查看版本历史。无需切换人工来源或启用人工资料；真实 sid、名称、国家、站点、仓库及领星快照保持只读，不向领星发送请求。“来源设置”和“新增人工店铺”也使用独立小窗口，主页面保留搜索、状态筛选、操作栏和目录列表。

`POST /api/v1/seller-mappings/:id/aliases` 接受严格 JSON：

```json
{
  "operationId": "00000000-0000-4000-8000-000000000001",
  "expectedVersion": 1,
  "expectedCatalogSettingsVersion": 1,
  "expectedCatalogVersion": 1,
  "aliases": [],
  "status": "approved",
  "reason": "核对来源名称后维护本地需求别名"
}
```

返回 `{mapping,replayed}`，复用映射 DTO。仅当前领星模式可调用；绑定来源设置、目录与映射三个版本，变化返回409要求重新核对。`status`仅接受`approved`或`disabled`，分别表示保留/恢复领星可用状态或设置领星本地停用，不接受`candidate`。纯领星记录即使`manualEnabled=false`也可维护，保存不会启用人工资料、修改人工`status`或覆盖其字段。领星已不再返回的店铺不能保存；远端授权状态非1或尚未获得自动批准标记时不能恢复；本地停用但远端仍有效授权且已有自动批准标记的店铺可经显式保存恢复。

需求别名可留空，`aliases:[]`不影响按正式名匹配；导入表与当前来源下的正式店铺名称一致时，无需重复维护别名。正式名及可选别名均按NFKC、首尾空白和小写规范化后精确匹配，只自动解析唯一的有效已批准店铺；同名店铺、别名与他店正式名碰撞均保留人工确认，不优先选择其中一家。有效状态为候选或停用、未授权、当前来源不可见的店铺不能自动解析；未授权或移出当前领星目录的店铺也不能用于本次导入确认。来源国家冲突仍报错。别名之间仍全局唯一，仅在来源名称与正式名不同时按需维护。

领星别名与本地停用/恢复操作均须填写`reason`，不再使用首次批准勾选代替原因。人工资料的首次批准规则不变：仅人工模式下当前为待确认且该来源完整历史从未批准时，可发送`identityConfirmed:true`，省略或留空`reason`；服务端保存包含人工店铺名、sid和国家的核对依据。已有候选别名不妨碍首次人工批准，已批准后再退回候选也不能再次使用首次规则。其它人工修改、重新批准与停用均需原因，伪造确认标志不能绕过服务端检查。

映射DTO包含`autoApproved`：仅领星来源反映自动批准标记，人工来源为false；当前是否可用仍取决于有效`status`与远端授权，不能只看该标记。`hasApprovedBefore`由当前来源的有效状态与该来源全部修订前后快照计算，领星自动批准历史不替代人工批准，页面最近100条历史的展示范围不影响判断。未知请求字段（包括sid、name、country、marketplaceId、wid及内部自动批准/停用列）一律422。更新本地别名和领星停用决定、递增映射及目录版本、记录完整前后快照与审计在同一事务中完成；冲突整体回滚。幂等重放以原请求为准，返回原结果，重放前仍检查管理员权限。

409错误码包括`SELLER_CATALOG_CONFLICT`、`SELLER_UNAVAILABLE`、`SELLER_NOT_AUTHORIZED`；其余鉴权、版本和别名冲突沿用下文。可信缓存迁移及成功同步在本地记录自动批准版本和`seller_mapping.auto_approve`审计，不通过列表GET触发。后续新解析按当前来源的有效正式名或别名匹配；旧源行快照不重写，需要重新解析才能更新原警告。导入提交仍保留本次店铺及差异确认步骤。

隔离回归可使用`apps/server/src/modules/seller-mappings/aliases.test.ts`及目录相关测试验证身份保护、来源独立状态、版本冲突、权限、幂等和事务回滚；浏览器技术回归使用本地模拟响应检查小窗口与人工维护兼容性，不要求重新访问领星。实际执行结果以本轮验收记录为准。

## 店铺来源扩展（2026-10-17）

默认来源为领星实际数据，人工维护作为独立本地profile保留。接口均带`/api/v1`，仅有效管理员访问；修改绑定operationId，原请求重放返回原结果，异请求409。

| 接口 | 请求及结果 |
| --- | --- |
| `GET /seller-mappings/catalog-settings` | `{settings}`：mode、version、catalogVersion、lastSyncedAt、lastError、configured、readOnly=true |
| `POST /seller-mappings/catalog-settings` | `{operationId,expectedVersion,mode:'lingxing'或'manual'}`；返回settings/replayed |
| `POST /seller-mappings/sync` | `{operationId,expectedVersion}`；仅查询实际店铺，返回settings/inserted/updated/total/replayed |
| `POST /seller-mappings/manual` | `{operationId,sid,name,country}`；新增人工店铺或首次启用既有sid的人工资料，初始为candidate，不继承领星批准；返回mapping/replayed |

目录列表另返回settings；mapping包含dataSource、manualEnabled、lingxingName、lingxingStatus、identityLocked、hasApprovedBefore和autoApproved。领星模式使用真实快照中的sid/name/country/marketplaceId及授权状态，来源时间/哈希对应归档，状态由领星独立字段计算；不把手工name或人工批准状态覆盖成远程实际值。人工模式使用保留的本地字段和原status，允许维护显示名和国家；未被领星观察、未被需求引用的人工sid允许更正，已绑定身份禁止原地修改。

同步在事务外执行受白名单约束的`GET /erp/sc/data/seller/lists`，成功后不可变文件、索引、远程字段、目录版本和审计共同保存；失败保留旧目录和上次成功快照，记录安全错误。同操作并发时只发布一次，较晚失败若已有成功结果则重放成功，不覆盖错误状态；网络阶段并发可能发生重复只读查询。远程不再出现的店铺仅标记本次不可选，不删除人工资料或历史引用。

mode切换递增设置version；成功同步、人工创建/修订及领星别名/停用维护递增catalogVersion，幂等重放不重复递增。显式同步中的新增自动批准记录修订和审计，已有本地停用决定保持。升级`0011_next_thunderbolts.sql`只处理具备完整有效身份、授权和匹配JSON归档索引/哈希的缓存，不发远程请求；发生自动批准时更新目录版本。导入预览/提交绑定两个版本与mode，变化后409要求重新确认。全流程不通过领星接口改名、改货件或写库存，GET也不批准或修订店铺。完整目标见[店铺来源与成品表](../business/store-sources-and-output-target.md)。

下文为原D05维护接口说明；本节更新其sid更正及数据源边界。

日期：2026-10-17。范围：T05 D05 维护切片及管理员单角色变更。基础路径 `/api/v1/seller-mappings`。页面 `/settings/seller-mappings`。

认证沿用 Better Auth。同源会话；仅有效管理员可查询及修订，不再提供其他账户的只读范围。事务内再次检查数据库管理员身份及停用状态。写请求拒绝不受信任 Origin/跨站请求。所有响应禁止缓存，错误包含 `error.code`、`message`、可选 `details` 和 `traceId`。

| 方法与路径 | 请求 | 响应及约束 |
| --- | --- | --- |
| `GET /` | `page` 默认1、`pageSize` 默认20且最大100；可选 `search`、`status` | `{items,total,page,pageSize}`；按 sid、id 稳定排序；名称、国家、sid、别名搜索；状态 candidate/approved/disabled |
| `GET /:id/history` | UUID | `{items}` 最近100个不可变修订，按版本倒序；对象不存在404 |
| `POST /:id/revise` | JSON，见下文 | `{mapping,replayed}`；仅人工模式；版本冲突409；sid更正受身份锁约束 |

修订请求字段：

```json
{
  "operationId": "00000000-0000-4000-8000-000000000001",
  "expectedVersion": 1,
  "sid": 12345,
  "name": "待业务核对的店铺名称",
  "country": "待核对国家",
  "marketplaceId": null,
  "wid": null,
  "aliases": ["待业务确认的来源名称"],
  "status": "candidate",
  "reason": "本次核对或变更依据"
}
```

以上为协议示意，不是已批准业务数据。未知字段被拒绝。名称、国家必填；原因除上述首次勾选批准情形外必填，人工维护的首次批准也支持 `identityConfirmed:true`。别名可为0至50个。`marketplaceId` 为站点文本 ID 或 null；`wid` 为最多20位正整数文本或 null，缺少 wid 不阻塞无库存依赖的批准。目的 FC、mid 均不能填作 wid。

映射 DTO：`id`、真实整数 `sid`、`name`、`country`、`marketplaceId`、`wid`、`aliases`、`status`、`version`、ISO时间 `updatedAt`/`sourceObservedAt`、`sourceSha256`及本节来源字段。修订请求中的sid可省略；已有领星观察或需求引用时不可更改。不返回本地存储路径、账户凭据或领星密钥。历史项包括 `operationId`、`version`、`actorUserId`、`reason`、`createdAt`、`before`/`after` DTO；新建记录的原始before为空对象，客户端按“新增资料”展示，其余修订保留完整前后值。

别名以NFKC → trim → lowercase生成数据库唯一键，解析采用相同规则的精确匹配。按当前来源的有效状态过滤，候选和停用记录不自动解析，不从相似名称推断sid；原人工status为candidate不妨碍已独立自动批准的领星身份生效。停用保留已占用别名；重新分配需先显式移除旧别名，再对目标店铺修订，均保留历史。

事务按 operationId 串行核对重放，再检查预览版本。同一操作号、操作者、对象及内容返回原历史结果，即使预览版本已经过时；同号不同请求返回 `OPERATION_CONFLICT`。不同操作号竞争同版本只允许一个提交。别名冲突返回 `ALIAS_CONFLICT`，映射、别名、修订和审计共同回滚。已撤权用户即使重放历史请求也不能写。

| 状态码 | 错误码 |
| --- | --- |
| 401 | UNAUTHORIZED |
| 403 | FORBIDDEN |
| 404 | NOT_FOUND |
| 409 | VERSION_CONFLICT、OPERATION_CONFLICT、ALIAS_CONFLICT、SID_CONFLICT、SID_IMMUTABLE、CATALOG_READ_ONLY、MANUAL_PROFILE_REQUIRED |
| 422 | VALIDATION_ERROR，字段校验可含 details |
| 503 | DATABASE_UNAVAILABLE、LINGXING_REQUESTS_DISABLED（恢复环境禁止目录同步） |
| 500 | INTERNAL_ERROR，服务端只记录固定事件及安全错误码 |

后台精确解析函数 `resolveApprovedSeller` 返回映射ID、sid、国家、站点、wid、版本；没有唯一有效的已批准正式名或别名匹配时返回 null。T09解析复用相同规则；T10–T11另允许管理员为本次导入显式选择人工来源的候选店铺并保存确认快照，不修改全局别名或批准状态。领星来源只接受当前有效的已批准身份，不能通过本次确认绕过撤权或本地停用。正式需求确认遵循[导入契约](./imports.md)，目录维护本身不等于完成业务导入。
