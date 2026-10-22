# 2026-10-18：B 站合集卡片打开最新一集（Claude，F31 前端）

编辑登记：Claude 本轮修改 `src/lib/works.ts`（`workLines` 的合集一行用 `latestMemberUrl ?? originalUrl`，新增 `opensLatest`）、`src/components/works-card.tsx`、`bili-card.tsx`、`social-work-card.tsx`、`home-works.tsx`（悬停提示）、`tests/works.test.ts`，新增决策记录。契约与接口由后端 446 提供；本次未改契约、接口与媒体路由、fixtures、依赖、栏目开关、全局入口与后端代码。

决定见 [决策记录](../decisions/2026-10-18-collection-opens-latest-episode.md)。

## 怎么验证的

- `tests/works.test.ts`：有最新一集地址时用它（即使合集列表页没有核验）、没有时退回列表页、两者都没有不可点、单个视频不变。
- 本机生产构建（`CONTENT_PROVIDER=mock SOCIAL_PROVIDER=mock`，后端的虚构数据）：演示合集“视频作品 03”在作品页链接到 `https://www.bilibili.com/video/BV0000000002/`，悬停提示“打开最新一集”。
- 类型检查、测试与构建见合并请求说明。

## 限制

- 正式站点上真实合集的地址要等后端安装迁移、核验并打开 `SOCIAL_COLLECTION_PLAYBACK` 之后才有；在那之前卡片照旧打开合集列表页，前端不用再改。
