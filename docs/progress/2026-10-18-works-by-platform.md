# 2026-10-18：作品页按平台分开、各自排序（Claude）

编辑登记：Claude 本轮新增 `src/components/works-card.tsx`，修改 `src/app/works/page.tsx`、`src/app/works/loading.tsx`、`src/components/works-list.tsx`、`src/lib/works.ts`（`worksPlatforms`、`worksHref`、`worksDay`、`groupWorksByPublishedYear`）、`src/app/timeline.css`、`src/app/skins.css`，新增决策记录。接口、契约、mock 由后端 434 提供；本次未改契约、接口与媒体路由、fixtures、依赖、栏目开关、全局入口与后端代码。

决定见 [决策记录](../decisions/2026-10-18-works-by-platform.md)。

## 怎么验证的

只在演示数据下验证：本机生产构建，`CONTENT_PROVIDER=mock SOCIAL_PROVIDER=mock`（后端准备的 56 件虚构作品，每个平台 28 件），无界面 Chrome。

- `/works`：B 站当前，排序“最新”，一行 4 列，年份 2026／2025／2024，合集写“最后更新 7 月 13 日”，封面上只有播放与集数；`?order=views`：不分组，播放从高到低（1万、900、800）。
- `?platform=xiaohongshu`：一行 5 列，封面完整 3:4，左下点赞；`&order=likes`：不分组，点赞从高到低。390 宽两列。不支持的组合（小红书按播放）落回默认，页面 200。
- 滚到底自动加载第二页，B 站与小红书点赞排序都到 28 件，每次一个带对应 `platform`／`order` 的请求；没有“新增”字样，B 站卡上没有点赞。
- 1280、768、390、320；墨水浅深、苹果浅深、像素深色、千禧：没有横向溢出；像素主题封面方框。
- 类型检查、测试与两种构建见合并请求说明。

## 限制

- 真实作品要发布后看（后端 434 与本次需一起发布）。
- 切换里的平台图标（同日补改）：B 站是 B 站蓝的小电视，小红书是红底白字的应用图标（原来用的字标与旁边的“小红书”读着重复）；颜色在四套主题下不变。本机演示数据下看过墨水浅深与像素深色。
