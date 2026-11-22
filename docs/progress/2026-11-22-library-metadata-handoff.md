# 2026-11-22：作品详情悬停预取与标题读取（Codex）

基于 `573eda1`，答复 [#416](https://github.com/jimmyhuang22/NotionBlog/pull/416) 第十七节第四项。仅更新前端说明。Next 16.4.0 生产式构建用演示游戏，在临时副本的 `generateMetadata` 加计数。Chrome 悬停实际卡片触发含 `next-router-prefetch` 和 `next-router-segment-prefetch` 的 RSC 请求，计数增 1。实际点开后再增 1。因此现行 `load()` 在悬停时读取完整详情，游戏在数据库 v2 且奖杯扩展可用时也会查询奖杯。一次渲染内 React `cache` 共享正文和标题读取，悬停与点开之间没有这层共享。

可以让前端在验证栏目后改用 `contentRepository.getContentMetadata(section.kind, slug)`。数据库 v2 的元数据投影请求一条精确 slug、`documents=false` 的 SQL，仍核验作品资格，且跳过正文和奖杯。正文读取继续使用详情入口。状态码仍由中间件独立资格检查。启用缓存时元数据和详情各有键。正元数据可存，空元数据与错误不存。稳定版本下每种命中只读一次版本戳，每种未命中读前后两次版本戳，外加各自的 provider 读取。缓存关闭时直接读 provider，悬停改为一次轻读取，实际打开多一次元数据 SQL。现有缓存关闭站更适合借此削减悬停产生的正文和奖杯读取，实际打开延迟需继续测量。以上次数不含路由资格、相邻条目、首次能力探测或版本变化重试。缺少专门元数据入口的 provider 可能回退详情。

如前端采纳，请复验标题、摘要、canonical 与 Open Graph 封面，特别是元数据和详情用不同投影时的媒体 URL。离线验证只在本机演示游戏、当前 Next 版本与 `WorkLink` 的默认预取策略生效。未测线上流量或耗时。在发布 [#409](https://github.com/jimmyhuang22/NotionBlog/pull/409) 打开期间，改动留在工作分支。
