# T05 只读输入核验

这是开发取样工具，不是 M1 正式导入器。它不修改源文件、不执行公式或宏、不确认日期口径和来源身份，也不把两份历史文件自动认定为每日增量。

在项目根目录运行：

```powershell
./scripts/t05/inspect.ps1 -Source 'D:/SCM-Automation/.local/development/data/t05/inbox/initial/真实导出.xlsx' -Out 'D:/SCM-Automation/.local/development/data/t05/review/initial-profile.json'
```

上例文件名须替换为实际文件。可用 `-Source @('首次.xlsx','每日.xlsx')` 同时核验；来源表相同及先后关系仍由导出记录证明。表头不是第一行时传入 `-HeaderRow`，不能仅凭工具输出自动判定业务表头。

- XLSX：保留 sheet 名/隐藏状态、合并范围、隐藏行列、首行标题、列类型计数、数字格式 ID/自定义格式、1900/1904 日期系统，以及公式缓存存在/空/缺失状态。正文值和公式内容不写入报告。
- CSV/TSV：按文本统计，不把 `001`、`0` 或空值自动转换。编码默认 UTF-8，可显式指定 `-Encoding gb18030`；不猜编码。
- 旧 XLS 不支持，明确返回错误。请取得真实 XLSX/CSV/TSV 或后续经业务核对的转换副本，不能仅改扩展名。
- 报告保存来源路径、大小和 SHA-256，可能含私有表头，必须写入受控目录。输出已存在或等于源文件时拒绝覆盖。
- ZIP/工作表规模、压缩包路径及 XML 实体受限。失败时非零退出，日志只包含固定错误码，不输出正文值。

脚本优先使用本机附带 Python 3，也可通过 `-PythonPath` 指定实际可执行文件，不需要新增 Python 包。

单元测试使用临时合成 ZIP/CSV，属于工具测试：

```powershell
# 使用与 inspect.ps1 相同的 Python 3 可执行文件
python -m unittest discover -s scripts/t05 -p 'test_*.py' -v
```

真实样本及业务决定清单见 [T05 输入确认](../../docs/business/feishu-intake.md)。
