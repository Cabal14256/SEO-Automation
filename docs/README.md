# 项目文档索引

- [M5–M8 交付与真实资料清单](./m5-m8-implementation.md)
- [M5–M8 工作流 API](./api/workflows.md)

公开文档记录规则、接口与开发方法。店铺、货件、商品、物流商和渠道示例使用虚构标识；已移除原件名称、数据量、实际编号与哈希。历史业务证据另行受控保存，公开说明不构成新的真实业务验收结论。

- [业务规则](./business/rules.md)
- [发票箱规取数与人工修改](./business/invoice-box-data.md)
- [店铺来源与输出目标](./business/store-sources-and-output-target.md)
- [输入确认与增量规则](./business/feishu-intake.md)
- [货件级导入字段](./business/manual-import-fields.md)
- [字段映射](./business/field-mapping.md)
- [箱分配与编码算法](./business/us-allocation-algorithm.md)
- [制表可行性与风险](./business/shipment-table-feasibility.md)
- [发票文件接口与数据库矩阵](./business/invoice-file-generation-api-db-matrix.md)
- [外部接口能力](./integrations/capabilities.md)
- [领星探测脚本](./integrations/lingxing-probe.md)
- [头程业务渠道查询](./integrations/fba-logistics-channel.md)
- [领星单据资料查询与权限](./integrations/lingxing-document-profiles.md)
- [数据模型](./data-model.md)
- [开发计划](./development-plan.md)
- [实现状态](./implementation-status.md)
- [店铺映射 API](./api/seller-mappings.md)
- [导入 API](./api/imports.md)
- [本次发货分票、编号与自动整理](./api/shipping-runs.md)
- [批次与制表 API](./api/batches.md)
- [旧实物箱核对 API（历史兼容）](./api/physical-review.md)
- [发票与单据 API](./api/documents.md)
- [M4 实施与验收边界](./M4%20PLAN.md)
- [验收场景](./acceptance/scenarios.md)
- [月内发货次验收与迁移](./acceptance/monthly-shipping.md)
- [业务验收操作](./acceptance/t13-t22-runbook.md)
- [运行与维护](./operations.md)
- [试用部署](./deployment/trial.md)
- [正式部署计划](./deployment/formal-deployment-plan.md)
- [隐私检查与 GitHub 发布](./privacy.md)
- [干净根仓库上传步骤](./github-publishing.md)

真实[业务源文件](./private/README.md)、[研究材料](./research/README.md)和[验收证据](./acceptance/evidence/README.md)不随公开仓库发布。这些目录只保留通用说明；应用不得依赖私有研究档案作为运行输入。

正式业务决定写入 `business`，接口变化同步更新共享契约、文档和验收场景。公开示例只验证算法与错误处理，实际账号授权、分页、续约、实物核对和人工签收需要另行完成。
