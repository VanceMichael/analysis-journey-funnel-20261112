# 数据与现有口径

事件时间、收到时间均为演练时间轴的分钟，id 是逻辑事件键。

`data/records.json` 是版本为 1 的演练数据，所有人员、机构、商品和交易均为本地合成记录。`id` 是导入记录键，不自动代表企业、访问或其他统计单位；记录键不得重复。数值字段必须有限，整数字段不得超过安全整数范围。空字符串可用于字段约定允许的未公开标签，不用零冒充缺测。

| 字段 | 类型 |
| --- | --- |
| `id` | `string` |
| `event_id` | `string` |
| `person` | `string` |
| `device` | `string` |
| `event` | `string` |
| `time` | `integer` |
| `received` | `integer` |
| `sequence` | `integer` |
| `revision` | `integer` |
| `region` | `string` |

现有 `summary` 按 `event` 清点记录，`sum` 为 `time` 的逐行核对值，不代表统计推断或跨期业务指标。分组按键排序，行按记录键稳定处理。`data/expected-summary.json` 是独立生成的现有核算对照；`data/policy.json` 保存业务配置的演练值，清点命令不消费分析配置，`journey` 命令的旅程漏斗口径消费该配置，见 `docs/journey.md`。`data/examples/` 保存旅程口径的可复核小例子。

`inspect` 返回输入行数、字段列表与 SHA-256 指纹；指纹不依赖字段或记录排列。数据版本不支持时应直接拒绝，不做静默迁移。错误发生时命令返回非零退出码。
