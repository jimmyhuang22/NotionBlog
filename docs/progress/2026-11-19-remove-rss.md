# 2026-11-19：移除网站 RSS（Claude）

编辑登记：Claude 删除 `src/app/feed.xml/route.ts`，修改 `src/app/layout.tsx`、`src/lib/seo/discovery.ts`、`src/lib/seo/metadata.ts`、`tests/website-queries.test.ts`，新增 `tests/seo-no-feed.test.ts`，更新 `README.md`、`docs/FRONTEND_GUIDE.md`、`docs/WEBSITE_CAPABILITIES.md`、`docs/REQUIREMENTS.md`、`docs/assets/readme/architecture.svg` 与明暗两张 PNG，新增决策 [移除网站 RSS](../decisions/2026-11-19-remove-rss.md)。契约、媒体路由、取数层、fixtures、栏目开关、依赖与站点配置未改；`src/app/api/` 下的路由未改（`/feed.xml` 不在其中）。

## 改了什么

- 页脚：去掉“订阅”与 `hasFeed()`、`discoveryOptions` 导入；其余链接（联系我、Notion 源站、回到顶部）和演示提示不变。
- 路由：删除 `/feed.xml`；`discovery.ts` 删除 `feedXml()` 及只为它导入的 `documentPlainText`、`contentDate`、`compareContent`（以及无用的 `AnyContent`）。站点地图与 `robots.txt` 不变。
- 元数据：`siteMetadata()` 不再有 `alternates.types`；`contentMetadata()` 的 `alternates` 只剩 canonical。
- 测试：删去 RSS 断言；新增 `seo-no-feed.test.ts`，用虚构的开启收录配置（`https://example.test/`）读真实的 `metadata.ts`：根与详情都没有 RSS 声明，详情 canonical、Open Graph、`robots` 符合现规则；关闭收录时什么都不声明。
- 文档与 README 结构图：“站内搜索与 RSS”改为“站内搜索”，按图稿说明（1200 × 580、两倍像素）重新导出明暗两版。

## 怎么验证的（本机离线正式构建，演示数据）

- `GET /feed.xml` 404，`HEAD /feed.xml` 404。
- `/`、`/status`、`/about`：200，页面里没有“订阅”，也没有 `application/rss+xml`；`/sitemap.xml`、`/robots.txt` 200。
- 390 手机页脚：只有“回到顶部 ↑”（演示配置没有邮箱和 Notion 源站），无横向溢出。
- 首页时间线“加载更早的内容”：16 条 → 32 条，末尾“已显示 32 / 36 条”；`/api/home/feed-v2` 200。
- Node 24.21.0：`npm run check` 与 `npm run build`，结果见合并请求。

## 限制

- 开启收录的元数据只用虚构配置在测试里核对，没有起一个开启收录的站点。
- 正式站点更新要等双站发布；届时在上海和新加坡各抽查页脚、页面元数据和 `/feed.xml` 的 404。
- 发布请求 #396 开着，这次先开合并请求，暂缓合进 develop。
