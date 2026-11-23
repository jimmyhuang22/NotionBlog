# 2026-11-24：游戏详情改成卡片，正文切换（Claude）

编辑登记：Claude 修改以下文件：

- `src/components/work-detail.tsx`（`GamePage`、`GameDates`、`TrophySummary`，删去 `TimeBars`，`WorkRecord` 加 `bare`）；
- `src/components/game-trophies.tsx`（导出 `TrophySetBody`、`TrophyTabs`，去掉原来自成一节的 `GameTrophies` 和切换按钮上的个数）；
- `src/app/library.css`；
- `src/lib/game-trophies.ts`（新增 `trophyAnchors`、`readTrophyAnchor`）；
- `src/lib/work-record.ts`（新增 `gameNotes`）；
- `src/lib/library.ts`（去掉“预计时长”的文案）。

新增 `src/components/game-panel.tsx`，补了 `tests/game-trophies.test.ts` 和 `tests/work-record.test.ts`。文档新增 [决策](../decisions/2026-11-24-game-detail-cards.md)，更新 `docs/FRONTEND_GUIDE.md` 游戏详情的三条。

契约、fixtures、接口、依赖、栏目开关都没改。`Game.estimatedTime` 仍在契约里，页面不再读它，等 Codex 按交接包删。

## 做了什么

- 主视觉下面全是卡片：
  - 左栏“我的游玩”：状态、评分、已玩时长、奖杯。几个平台一行一个，点了切到那个平台的奖杯；只有一套时是进度圈。
  - 左栏“关于”：类型标签。
  - 右边时间线卡片：居中的步骤条，没有标题（丙）。
  - 右边正文卡片：“游玩感受 ｜ 奖杯”切换，默认感想。选择记在网址里（`#trophies`、`#trophies-ps5`）。
- 去掉“预计”：左栏只写“166 小时 已玩”，两根对比条删了。
- 手机一栏，顺序是我的游玩、时间线、正文、关于、上一款 / 下一款。

## 怎么验证的

- 本机演示站点加一个未提交的预览页，数据是线上《女神异闻录5皇家版》《识质存在》的详情接口读取，外加演示日期情形：同一年、跨年、日期未记录、什么都没有、想玩、四个日期跨四年。
- 宽度：1440、900、390、320。外观：岛屿浅色与深色、墨水浅色与深色、苹果浅色与深色、千禧。
- 交互：
  - 点“奖杯”标签，地址变成 `#trophies-ps5`；
  - 点左栏 PS5 一行，切到 PS5 的奖杯；
  - 带 `#trophies-steam` 打开，直接是 Steam 那一页；
  - 没有横向溢出，没有报错。
- 单元测试：`trophyAnchors`、`readTrophyAnchor`、`gameNotes`。
- Node 24.21.0 下 `npm run check` 与 `npm run build`，结果见合并请求。

## 限制与下一项

- 只在本机演示站点和两款真实游戏的数据上看过，随下次发布在正式站点复验。
- 简介、开发、发行、游玩录像卡片等 Codex 的字段到了再接，见 `.local/handoffs/2026-11-23-game-estimate-and-info/HANDOFF.md`。正文里的“游玩录像”标题和链接在搬家之前照常显示。
- 墨水和苹果原来“正文直接写在页面上、没有卡片”，游戏详情现在四个外观都是卡片（用户看过墨水深色的卡片原型）。
