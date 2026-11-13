# 旅程漏斗口径

`journey` 命令在授权导出的事件上按"旅程"核算，不再把独立事件计数拼成漏斗。一次旅程从指定起点开始，在最长窗口内依序匹配各步骤；业务配置在 `data/policy.json`（可用 `--config` 替换），分析截点可用 `--cutoff` 覆盖。

```sh
node src/cli.js journey --out var/journey.json --recap var/journey-recap.md
node src/cli.js journey --period 0:1200 --period 1200:2400   # 同一配置两期并排
```

机器结果写入 stdout 与 `--out`；紧凑的中文复盘写入 `--recap`（缺省打印到 stderr，不污染 JSON 管道）。现有 `summary` 事件清点保持原样。

## 事件可见性、更正与去重

- 只使用 `received <= cutoff` 的事件；截点之后才收到的事件（含更正）不进入当时版本。同一数据在不同截点可得到不同结论，这是版本口径而非错误。
- 在可见事件内沿 `event_id` 取最高 `revision`；同 revision 重复导入取记录键较小者。重复导入不增加人数。
- `audit` 输出记录数、可见数、被截点排除数与被更正/重复剔除数，便于复核守恒。

## 身份

身份关系以 `identityLinks` 映射文件为准，每条链接带生效分钟 `effective`：

- 事件时间 ≥ 某条链接的 `effective` 时，该设备事件归属链接的 `person`；多条生效取 `effective` 最大者。
- 链接存在但尚未生效：事件记为 `anon:<device>`。后来绑定的设备不得把过去匿名旅程无条件合并。
- 设备无链接：回退记录自身的 `person`，为空则 `anon:<device>`。

## 旅程匹配

- 同一身份的事件按 `(time, sequence, id)` 排序；相同时刻由 `sequence` 稳定决定先后。
- 起点是匹配第一步（含 `where` 属性谓词）的事件；之后每一步贪婪取最早匹配事件，截止为 `min(起点 + windowMinutes, 上一步 + maxGapMinutes)`，边界含端点。
- `entry: "first"` 每个身份只保留第一段旅程；`entry: "every"` 允许结束后重新进入。
- `reuseEvents` 明确重叠旅程能否复用事件：`false` 时下一段旅程从上段最后消费的事件之后开始；`true` 时从上段起点之后开始，事件可被多段旅程复用。配置必须显式给出，不得省略。

## 状态、完成率与等待分位数

- `completed`：全部步骤匹配。`failed`：某步在其截止前无匹配且截止 ≤ 截点，`failure.limit` 区分 `window`（超出窗口）与 `gap`（超出步骤最大间隔）。`open`：窗口尚未成熟（截止 > 截点），事件仍可能到达。
- 完成率按已成熟旅程计：`completed / (completed + failed)`；未成熟旅程单独列示，不算失败。分母为 0 时完成率为 `null`。
- 步骤等待分位数（p50/p90，线性插值）只使用已经完成该段的旅程；未走完与未成熟都不计入。
- 每段（`segmentBy`，默认入口 `region`）输出 `journeys` 明细：身份、起点、匹配的事件键与时刻、状态、`failure`/`awaiting` 原因，点击任一段可核对真正纳入的旅程与未匹配原因；`failureReasons` 给出按步骤与限制的汇总。

## 两期比较

`--period 起始:结束` 可指定两次，按旅程起点时刻归入时期；匹配仍使用全量可见事件流。输出 `comparison` 为两期并排描述（完成率差、完成数差、各段 p50 差），`note` 与复盘均声明不作因果判断。

## 可复核例子（data/examples/）

共用配置 `data/examples/policy.json`（窗口 1440，checkout 最大间隔 60，截点缺省 3000，含 `d90→p90` 于第 1000 分钟生效的链接）。下列数字均有测试锁定（`test/journey.test.js`）。

| 例子 | 文件 | 要点 | 预期 |
| --- | --- | --- | --- |
| 重复起点 | `repeated-start.json` | 首次 open 后 60 分钟内无 checkout，再次进入才完成 | `every`：2 段旅程（先 `failed/gap` 后 `completed`）；`first`：仅失败的第 1 段 |
| 跨日支付 | `cross-day.json` | 第 1400 分钟进入、次日第 1500 分钟付款 | 1 段 `completed`，等待 [30, 70]；按日期透视会拆到两天，旅程视图不拆 |
| 身份延迟绑定 | `late-binding.json` | 绑定生效前的匿名 open→checkout 与生效后的 paid | 匿名旅程 `failed/window`（deadline 1540），不并入 p90；p90 的 paid 不单独成旅程 |
| 同刻多事件 | `same-time.json` | open 与两次 checkout 同在第 50 分钟 | 按 sequence 取首个 checkout，等待 [0, 10]，重复提交不重复计数 |
| 未成熟旅程 | `immature.json` | paid 在截点 2000 后才收到（received 2500） | `--cutoff 2000`：p80 为 `open`（不算失败），p81 为 `failed`；`--cutoff 3000`：p80 转为 `completed` |

复核命令示例：

```sh
node src/cli.js journey --input data/examples/repeated-start.json --config data/examples/policy.json
node src/cli.js journey --input data/examples/immature.json --config data/examples/policy.json --cutoff 2000
```
