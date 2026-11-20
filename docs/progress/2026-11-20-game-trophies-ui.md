# 2026-11-20：游戏详情的奖杯，前端先用演示数据做好（Claude）

编辑登记：Claude 新增 `src/lib/game-trophies.ts`、`src/components/game-trophies.tsx`、`src/app/preview/game-trophies/`（`page.tsx`、`demo.ts`）、`tests/game-trophies.test.ts`；修改 `src/components/work-detail.tsx`、`src/app/library/[type]/[slug]/page.tsx`、`src/app/library.css`、`docs/FRONTEND_GUIDE.md`、`docs/BACKEND_HANDOFF.md` 十六、[决策](../decisions/2026-11-20-game-trophies.md)（空正文提示的细化）。契约、fixtures、mock 仓库、接口与媒体路由、依赖、栏目开关未改。

## 做了什么

- 用户要求先用演示数据把奖杯页面做出来。Codex 正在另一个工作树里做第一步（`ContentDetail.trophySets`，改契约和 fixtures，尚未合入），所以前端不改契约和 fixtures，字段名照它的提案，读取时容错：回应里没有 `trophySets` 就什么都不显示，现在的线上页面不受影响。
- 左栏奖杯统计（`TrophySummary`）、正文下“奖杯”一节（`GameTrophies`）按决策的乙和第二轮五项落实；只有“奖杯”一节出现时才去掉“还没有写下游玩记录”（只有统计时保留，否则正文区是空的，决策里补了这条细化）。
- 第二步逐个奖杯的形状后端还没定，前端暂按交接包里写的字段读，后端改名时再跟。
- 演示页 `/preview/game-trophies`：只在演示数据下存在，用真实的游戏详情组件，六种情形（两个平台、一个平台、已白金、一个都没拿到、只有统计、没有奖杯）；奖杯名称、图标（生成的 SVG）、比例和日期全是虚构的。

## 怎么验证的

- 本机演示预览（`next dev`，演示数据），无头 Chrome：六种情形 × 1280 与 390，另点开“全部”“未拿到”、切到 Steam；单平台在墨水深色、岛屿、千禧、苹果 1280 各看一次。没有横向溢出，没有控制台错误。
- `tests/game-trophies.test.ts` 9 条（容错读取、隐藏奖杯遮蔽、只认站内图标、日期只到日、档位、排序与分组）。
- Node 24.21.0：`npm run check`（3506 条通过）与 `npm run build` 通过。
- **只在演示数据下验证过**；正式站点没有奖杯数据，线上游戏详情应和现在完全一样，发布后挑一款核对。

## 限制与下一项

- 等 Codex 合入第一步：合入后用它的演示数据看左栏统计，确认字段名一致；正式数据到位后挑 PS、Steam、任天堂各一款核对。
- 第二步合入后核对逐个奖杯的字段名，演示页改成读演示数据或删掉。
- 展开列表里的图标是懒加载，截图时没滚到的格子是空的，真实浏览会加载。
- 平台的 64×64 图标在高分屏上 48px 会略软。
