# 2026-10-17：作品库详情页加大封面加信息表、卡片不写未知状态（Claude）

编辑登记：Claude 本轮修改 `src/app/library.css`、`src/app/skins.css`、`src/lib/library.ts`、`src/components/library-grid.tsx`、`tests/library.test.ts`，新增决策记录。契约、接口与媒体路由、fixtures、依赖、栏目开关、全局入口与后端代码未改。

决定见 [决策记录](../decisions/2026-10-17-library-detail-and-card-status.md)。

## 改了什么

- 详情页：`.work` 收成 980 宽居中、封面 300（书 260，手机 220），信息 `.work__facts` 改成带底色和阴影的两列表格，“我的记录”同宽；像素主题给这张表加与搜索框相同的方框。
- 卡片：新增 `knownStatusLabel`，未知状态返回空；`library-grid.tsx` 改用它。详情页仍用 `statusLabel`，照写“状态未记录”。

## 怎么验证的

只在演示数据下验证：本机开发服务器（`CONTENT_PROVIDER=mock`，打开作品库各栏目），无界面 Chrome。

- 影视（未知状态的演示条目）、书籍（在读）、游戏（白金）详情：1280 与 390 宽，另看像素深色 1280、墨水深色 1280、苹果 390；都没有横向溢出，封面、状态、进度、信息表正常。
- 影视列表里那张未知状态的卡片不再写“状态未记录”，它的详情页仍写。
- `tests/library.test.ts` 6 项通过（新增：卡片对未知状态返回空、详情仍写“状态未记录”、白金与“想玩”照常）。类型检查、全部测试与构建见合并请求说明。

## 限制

- 真实条目的样子以原型截图为准（忽略的 `.local/theme-options/2026-10-17-library-detail/`），正式站点要发布后看。
- 一张既没有已知状态、又没有其他信息的卡片，标题下面就是空的（演示数据里有一张）。
