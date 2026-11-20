# 2026-11-20：游戏奖杯第一步的前后端联调（Claude）

编辑登记：只新增本记录。代码、契约、fixtures 未改。

## 做了什么

- Codex 的第一步（`codex/game-trophy-summaries`，详情回应的 `trophySets`、PSN 统计、演示数据）还在它的本地工作树里，没有提交。它在交接里请前端照“交给 Claude 的第一步联调”核对。
- 联调用一份临时副本：最新 develop（含前端 #405）加上 Codex 工作树里 `docs/` 以外的改动和新文件（只读复制，没有改它的工作树）。副本里临时把离线模式的栏目开关改成打开游戏，`next dev --webpack`（Turbopack 不接受指向副本外的 `node_modules` 链接），用完删除，没有提交。
- 类型检查通过；`tests/game-trophies.test.ts` 与 `tests/game-trophy-summaries.test.ts` 共 12 条通过。

## 结果（演示数据，1280 与 390，墨水浅色）

| 页面 | 期望 | 结果 |
| --- | --- | --- |
| `game-clear` | 左栏 PS4、PS5 分开，正文照常 | 通过：PS4 15 / 30、PS5 0 / 20 各一行，和 `/api/content/game/game-clear` 一致 |
| `game-zero-trophies` | 0 / 8 | 统计通过：0 / 8、0%，白金金银铜都是 0；正文区见下面第一条 |
| `game-platinumed` | （未列） | 左栏有 PS5 一套 20 / 20 |
| `game-playing`、`game-wishlist` | 没有奖杯统计 | 通过 |

没有横向溢出，没有控制台错误。

## 需要后端处理的两处

1. **`game-zero-trophies` 没有正文记录**：`fixtureDocuments` 里没有 `mock-game-5`，详情的 `document` 是 `null`，页面按“读取失败”显示“游玩记录暂时没有加载，稍后刷新再试。”。要验证空正文的显示，请给它一个空正文（`{ blocks: [], toc: [], completeness: "complete" }`）。`game-playing`、`game-platinumed` 原来就没有正文记录，也是同样的提示，与奖杯无关。
2. **空正文提示的规则与交接不一致**：交接第一步联调写“`game-zero-trophies` 显示 `0 / 8`，省略‘还没有写下记录’”。[决策](../decisions/2026-11-20-game-trophies.md)在前端落实时细化为：只有正文下的“奖杯”一节出现（有逐个奖杯）时才省略；只有左栏统计时照常显示“还没有写下游玩记录”，否则正文区是空的。用户已知道这条细化。第一步只有统计，所以这款加了空正文后应显示那一行，请按决策改交接里的期望。

## 下一项

- Codex 补空正文、改交接措辞后提交并合入第一步；合入后前端在 develop 的演示数据上再看一次 `game-zero-trophies`。
- 线上要等迁移安装、PSN 统计导入和发布，之后挑 PS4 / PS5 各一款在正式站点核对。
