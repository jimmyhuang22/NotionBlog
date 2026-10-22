# 2026-10-17：游戏详情页的平台方框与时长写法（Claude）

编辑登记：Claude 本轮新增 `src/components/platform-chips.tsx`（卡片与详情共用），修改 `src/app/library/[type]/[slug]/page.tsx`、`src/components/library-grid.tsx`、`src/app/library.css`，新增决策记录。契约、接口与媒体路由、fixtures、依赖、栏目开关、全局入口与后端代码未改。

决定见 [决策记录](../decisions/2026-10-17-game-detail-platforms.md)。

## 怎么验证的

只在演示数据下验证（本机读不到正式站点的数据库，真实的三款在发布后看）：

- 本机开发服务器，演示游戏“已白金”：页头“白金 · PlayStation · 4 / 5 · 进度 75%”，信息表只剩游玩日期、已玩时长“45 小时”、预计时长“60 小时”，没有“平台”行；读屏标签依次是状态、平台、我的评分、进度。演示游戏“Demo Console”是中性底方框，时长按分钟“330 分钟”。
- 1280、390；墨水浅深、苹果、像素深色、千禧：没有横向溢出，像素主题方角。
- 类型检查、测试与两种构建见合并请求说明；平台简称、颜色与时长规则的单元测试在游戏卡片那次已有。

## 限制

- 发布后在正式站点看 Overwatch 2（PC）、塞尔达王国之泪（Switch）、女神异闻录 5 皇家版（PlayStation）。
