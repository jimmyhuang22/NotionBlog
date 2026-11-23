# 2026-11-23：游戏库换成卡盒，加“最近在玩”（Claude）

编辑登记：Claude 新增 `src/components/game-case.tsx`、`src/components/recent-games.tsx`、`src/lib/recent-games.ts`，修改 `src/components/library-grid.tsx`、`src/lib/library.ts`（新增 `gameCaseFace`，删去不再使用的 `gameCard`，`coverBadge` 不再给游戏返回白金）、`src/app/library/[type]/page.tsx`、`src/app/library.css`、`tests/library.test.ts` 和前端接手说明。没有改契约、fixtures、依赖、栏目开关和 `src/app/api/`、`src/app/media/`。

## 做了什么

- 按 [2026-11-23-game-cases](../decisions/2026-11-23-game-cases.md) 和 [2026-11-23-game-case-status-badge](../decisions/2026-11-23-game-case-status-badge.md) 把游戏库的卡片换成卡盒，游戏库上方加“最近在玩”转盘。
- 接 #464 合进来的可选字段 `Game.boxArt`、`Game.platformPlayTime`，平台用共用的 `selectGameCasePlatform`，与后端挑封面同一个规则。
- “最近在玩”在服务端按 50 一页读完游戏列表（最多 12 页），按 `lastPlayedDate` 取最近 8 款；列表接口按手填日期排序，不能直接取。读取失败只在这里写一句说明。

## 验证方式

- 本机生产构建，线上 317 款游戏的列表接口数据（2026-11-23 取一次）叠上数据库一侧试装的 123 张 Steam 竖图和分平台时长，在一个不提交的本地页面里渲染真实组件；封面经本地代理从线上取。
- 无界面 Chrome 截图：墨水浅色、深色，1280 与 390；岛屿深色、苹果浅色、千禧浅色，1280。
- 《守望先锋2》《识质存在》在转盘中间，2× 与 3× 下实际取到 600×900 原图，“2”和 PRAGMATA 完整露出；状态在平台条右端。
- 去掉新字段（旧快照）时每个盒子都是横图顶替，页面正常。
- `npm run check`、`npm run build` 结果见合并请求。

## 限制

- 正式数据还没有竖版封面和分平台时长，上线后盒子全是横图顶替，直到 Codex 导入。
- “最近在玩”每次请求读完整个游戏列表（现在 7 页）；走公共缓存，但没在线上数据库上量过耗时。嫌慢时可请后端加“按最近游玩排序”（契约改动）。
- 游戏库的盒子取 400 小图，3× 屏上略软。
- 状态页签在标题行，年份行在转盘下面，中间隔着转盘；等用户看过再定要不要调整。
- 演示数据（mock）里的游戏没有竖图，只能看到横图顶替。

## 下一项

- 线上发布后用真实数据复验游戏库和“最近在玩”；Codex 导入竖版封面后再看一次 2×、3× 的清晰度。
