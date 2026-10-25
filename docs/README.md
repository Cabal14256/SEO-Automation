# 项目文档导航

本文面向源码阅读、内部维护与技术参考。项目具有特定业务、账号和运行环境依赖，使用边界见[根目录的内部项目声明](../README.md)。公开示例不代表真实业务签收。

## 从这里开始

| 目的 | 建议阅读 |
| --- | --- |
| 了解项目与启动方式 | [项目 README](../README.md)、[运行维护](operations/runbook.md) |
| 确认已经实现什么、哪些仍需验收 | [实现状态](development/implementation-status.md)、[M5–M8 交付说明](development/m5-m8-implementation.md) |
| 查业务规则与字段 | [业务规则](business/rules.md)、[字段映射](business/field-mapping.md) |
| 开发接口或调整数据结构 | 下方接口导航、[数据模型](architecture/data-model.md) |
| 整理资料并准备发布 | [隐私边界](publishing/privacy.md)、[GitHub 发布步骤](publishing/github-publishing.md) |
| 追溯早期方案 | [历史计划索引](archive/README.md) |

同一主题有多次变更时，先阅读当前实现状态及业务／API 文档中最新的明确规则，再查历史记录。`archive/` 中的阶段计划不作为现行操作指南。文档存在差异时应核对对应代码与共享契约，不以早期计划替代实际行为。

## 目录分工

```text
docs/
├── README.md          文档总导航
├── architecture/      数据模型与架构
├── business/          业务规则、字段和算法
├── api/               接口契约
├── integrations/      外部系统能力与只读接入
├── development/       当前实现、模块交付和前端控件
├── operations/        配置、日常操作与恢复
├── deployment/        试用部署、部署计划与开发代理
├── acceptance/        验收场景与验证方法
├── publishing/        隐私检查和 GitHub 发布
└── archive/           历史阶段计划
```

`private/`、原始研究、验收证据及业务模板的本地保存规则见本文末尾；目录树只列公开文档分类。

## 业务规则与字段

| 文档 | 内容 |
| --- | --- |
| [业务规则](business/rules.md) | 需求、分票、数量、箱码、冻结、更正和当前制单边界 |
| [店铺来源与输出目标](business/store-sources-and-output-target.md) | 店铺双来源、身份与只读范围 |
| [输入确认与增量规则](business/feishu-intake.md) | 来源接收、店铺确认、重复与变更处理 |
| [货件级导入字段](business/manual-import-fields.md) | 人工／表格输入的字段含义 |
| [字段映射](business/field-mapping.md) | 输入、发货表和单据字段对应 |
| [箱分配与编码算法](business/us-allocation-algorithm.md) | 分配、守恒、箱身份及编码规则 |
| [发票箱规取数与人工修改](business/invoice-box-data.md) | 自动来源、本票覆盖和最终箱数据 |
| [发票文件接口与数据库矩阵](business/invoice-file-generation-api-db-matrix.md) | 制单依赖、接口和持久化关系，含前期调查记录 |
| [制表可行性与风险](business/shipment-table-feasibility.md) | 前期分析与风险来源，当前交付以实现状态为准 |

## 接口契约

| 文档 | 范围 |
| --- | --- |
| [M0 基础接口](api/m0.md) | 认证、健康检查与示例任务边界 |
| [店铺映射 API](api/seller-mappings.md) | 目录、人工资料与映射维护 |
| [导入 API](api/imports.md) | 上传、解析、预览、提交、草稿与需求 |
| [发货次 API](api/shipping-runs.md) | 月内次数、票号、成员与自动整理 |
| [批次与制表 API](api/batches.md) | 分组、同步、确认、箱码和导出 |
| [发票与单据 API](api/documents.md) | 资料、模板、自动任务、修订、合并文件和复核 |
| [后续工作流 API](api/workflows.md) | M5–M8、交接、报关、费用与归档 |
| [旧实物箱核对 API](api/physical-review.md) | M3 历史兼容；不作为新发票的生成门槛 |

## 外部系统接入

| 文档 | 内容 |
| --- | --- |
| [接口能力与限制](integrations/capabilities.md) | 第三方查询范围、身份和取数边界 |
| [领星探测脚本](integrations/lingxing-probe.md) | 离线示例与受控只读探测 |
| [头程业务渠道查询](integrations/fba-logistics-channel.md) | 接口调查和接入约束 |
| [领星单据资料查询](integrations/lingxing-document-profiles.md) | 单据资料来源与账号权限 |

## 架构与开发

| 文档 | 内容 |
| --- | --- |
| [数据模型](architecture/data-model.md) | 表关系、版本、来源、文件和任务约束 |
| [实现状态](development/implementation-status.md) | 当前能力、变更记录和待验事项 |
| [M5–M8 实施与技术验收](development/m5-m8-implementation.md) | 模块链路、入口、限制与真实资料清单 |
| [前端控件说明](development/frontend-controls.md) | 控件选用、交互、进度与恢复规则 |

## 运行与部署

| 文档 | 内容 |
| --- | --- |
| [运行维护](operations/runbook.md) | 首次配置、业务操作、进程管理与备份恢复；旧阶段操作已注明边界 |
| [试用部署](deployment/trial.md) | Windows 试用环境、服务与隔离恢复 |
| [正式部署计划](deployment/formal-deployment-plan.md) | 目标设备与业务验收条件，属于部署计划 |
| [开发机领星代理](deployment/lingxing-dev-proxy.md) | 特定 Windows／Ubuntu 环境的出口配置与排查 |

## 验收与验证

| 文档 | 内容 |
| --- | --- |
| [验收场景](acceptance/scenarios.md) | 功能、异常、并发与恢复的核对场景 |
| [月内发货次验收](acceptance/monthly-shipping.md) | 编号、安排、更正、导出及迁移 |
| [业务验收操作](acceptance/t13-t22-runbook.md) | 资料预检、对账、版本包与显式签收 |
| [M5–M8 技术验收说明](acceptance/m5-m8-technical.md) | 工作流与隔离技术验证的范围 |
| [M5–M8 前端验证](acceptance/m5-m8-frontend.md) | 操作路径、恢复与界面验证 |
| [私有证据保存说明](acceptance/evidence/README.md) | 原始报告和截图的保存边界 |

验收文档说明检查方法与历史技术结果，不替代当前环境下的真实业务对账、接收系统导入、人工签收或部署验收。

## 隐私与发布

- [隐私检查与资料边界](publishing/privacy.md)
- [GitHub 发布步骤](publishing/github-publishing.md)
- [历史计划索引](archive/README.md)

## 仅供本地的资料

| 路径 | 用途 | Git 与发布规则 |
| --- | --- | --- |
| `docs/private/` | 原始业务示例、参考文件 | **整个目录禁止纳入 Git，包含 README；不进入源码导出或发布包** |
| `docs/research/` | 原始分析、SOP 提取和接口研究 | 仅保留[通用保存说明](research/README.md)；原始材料不发布 |
| `docs/acceptance/evidence/` | 真实报告、截图与核验记录 | 仅保留[通用保存说明](acceptance/evidence/README.md)；原始证据不发布 |
| `docs/templates/` | 本地业务模板原件 | 整个目录被忽略；运行模板由系统受控维护 |
| `.local/` | 开发、试用、备份及历史归档 | 整个目录被忽略，不属于源码 |

公开文档和自动化测试应使用独立编造的示例。私有资料不作为公开文档的必需依赖；应用通过受控 `DATA_DIR` 管理运行文件。新增正式业务决定写入 `business/`，接口变更同步更新共享契约、API 文档与验收场景，历史计划只保留设计追溯价值。
