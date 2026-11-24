# 2026-11-24：最近在玩的日期、读取失败和小图（Claude）

编辑登记：Claude 修改 `src/components/recent-games.tsx`（日期写法、新增 `RecentGamesFailed`）、`src/components/recent-games-section.tsx`（失败时用新部件）、`src/components/game-case.tsx`（去掉 `large`，一律 400 小图）、`src/app/library.css`（失败框、悬停日期的虚线），更新 `docs/FRONTEND_GUIDE.md` 游戏库一条，新增 [决策](../decisions/2026-11-24-recent-games-followups.md)。契约、fixtures、接口、依赖、栏目开关都没改。

## 做了什么

- 一周以内的游玩日只写“今天”“昨天”“前天”“N 天前”，悬停看日期，读屏读“今天 · 11 月 24 日”；更早的写日期。网页先写日期，浏览器用设备上的日期换成“今天”（`useToday`，和动态、作品页一样），页面缓存或开着过夜也不写错。
- 读不到时：左栏仍写“最近在玩”，右边虚线框和“重试”按钮；按下后变成“正在重试”，重新读取页面，游戏库不受影响。
- 最近在玩的竖版封面从 800 改成 400 小图。

## 怎么验证的

- 本机正式构建加未提交的预览页（线上数据存成 JSON，翻页和图片经本机代理读线上），宽度 1440、390：日期写法、悬停提示、读屏文字、失败框和重试、图片地址都是 `thumbnail=400`。
- Node 24 下 `npm run check` 与 `npm run build`，结果见合并请求。

## 限制与下一项

- 读取失败只在预览页里模拟过，没有在真实读取失败下看过。
- 随下次发布在正式站点复看。
