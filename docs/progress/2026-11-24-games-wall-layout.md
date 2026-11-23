# 2026-11-24：游戏页改成游戏墙（丙）（Claude）

- **页面**：游戏库 `/library/games`。[决策](../decisions/2026-11-24-games-wall-layout.md)。
- **组件**：`src/app/library/[type]/page.tsx`（游戏页宽版，标题旁放状态切换，传 `yearCounts`）；`src/components/recent-games.tsx`（转盘改成平放的一排，`RecentGamesWaiting` 移到这里）；`src/components/library-grid.tsx`（`GameWall`）；`src/components/section-waiting.tsx`（游戏的加载样子）；`src/app/library.css`（删去转盘和旧游戏网格样式）。
- **验证**：在本机临时预览页上，用 2026-11-23 抓取的线上 317 款游戏渲染正式组件。看过宽度 1280、900、390，浅色和深色，在玩／通关／想玩，以及加载时的样子；页面都不横向滚动。“最近在玩”加载时的占位高度和实际一样（电脑 397、手机 307）。真正的 `/library/games` 在本机构建里是关闭的，只能等发布后在线上看。
- **限制**：电脑上要指到盒子才显示名字；没有竖图的游戏横图裁切不好看的问题还在。
- **下一项**：随下次发布上线（和 #474 的 5 分钟留存一起），在两站复看排版并复量换筛选的耗时。
