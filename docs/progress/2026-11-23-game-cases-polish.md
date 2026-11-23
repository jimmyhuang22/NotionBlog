# 2026-11-23：游戏卡盒线上复看后的调整（Claude）

编辑登记：Claude 新增 `src/components/recent-games-section.tsx` 和决策 [2026-11-23-game-cases-live-polish](../decisions/2026-11-23-game-cases-live-polish.md)；修改 `src/app/library/[type]/page.tsx`、`src/lib/recent-games.ts`、`src/components/game-case.tsx`、`src/components/recent-games.tsx`、`src/lib/library.ts`、`src/app/library.css`、`tests/library.test.ts`、前端接手说明和 [2026-11-23-game-cases](../decisions/2026-11-23-game-cases.md) 第二行。没有改契约、fixtures、依赖、栏目开关和 `src/app/api/`、`src/app/media/`。

## 做了什么

- **性能**：线上 `/library/games` 整页约 1.4 秒（书籍约 0.2 秒），整页在等“最近在玩”读完 7 页游戏列表。现在转盘单独流式加载，列表先出来；读取结果在服务端留 5 分钟，这期间换状态、年份、排序不再等它。
- 先试过把标题和转盘放进只给列表用的路由分组布局（`(list)/layout.tsx`），换筛选时布局保留、转盘完全不重读（临时页面实测点击后 59 毫秒更新）。但整套检查里 `tests/qualified-shared-budget.test.ts` 失败 9 项：同步服务的发布校验（`scripts/website-sync/release.mjs`）只接受字母、数字和 `_ . / [ ] -` 的文件路径，括号会让服务器上的发布校验失败。已撤回，改成上面的做法。
- **顶替图**：横图填满封面框，盒子里不再重复写名字。
- **顺序**：“游戏库”小标题和状态切换挪到转盘下面，和年份、排序挨着。
- **文字**：“最近在玩”去掉“8 款 · 按最近一次游玩”；日期今年不写年份；Switch 与 Switch 2 不再互相写成“也在”。

## 验证方式

- 本机生产构建，用不提交的本地页面渲染真实组件：线上 317 款游戏的列表数据（2026-11-23 取一次），去掉新字段（现在线上的样子）与叠上试装 Steam 竖图两种；墨水浅色、深色，1280 与 390。
- 本机构建会强制关掉影视、书籍、游戏栏目，真正的 `/library/games` 打不开；耗时改善要发布后在线上量。
- `npm run check`、`npm run build` 结果见合并请求。

## 限制

- 服务端留存过期后（每台服务器每 5 分钟一次）的那一次筛选切换，仍要等转盘读完（约 1.2 秒）；后端给列表加“按最近游玩排序”后可去掉留存。

- 横图裁切会切掉印在画面中间的标题字（例如宝可梦朱紫），竖版封面导入后消失。
- 竖版封面要等 Codex 合并并发布同步那部分代码、导入封面、跑一轮同步后，线上才会出现。

## 下一项

- 发布后量两站 `/library/games` 的耗时，看首屏是否接近书籍页、筛选切换是否只等列表本身。
