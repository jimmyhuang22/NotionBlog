# 2026-10-19：首页 B 站卡片角标改用按天累计（Claude，F37 后续）

编辑登记：Claude 本轮修改 `src/lib/home-feed.ts`（新增 `collectionBadge`）、`src/components/bili-card.tsx`、`tests/home-feed-display.test.ts`。契约、接口与媒体路由、fixtures、依赖、栏目开关与后端代码未改。

后端 #507 给合集加了可选的 `dayAddition`（活动当天的累计新增与依据）。角标与读屏文字按 `dayAddition ?? latestAddition` 取：有当天累计时直接用它的数字，不在前端相加；依据为“发现”时读“发现新增 N …，发布时间未知”，“混合”时读“新增 N …，其中部分发布时间未知”；当天累计为 0 时不显示角标。后端开关默认关闭，`dayAddition` 为空时与发布 505 的样子相同。

验证：`collectionBadge` 的单元测试覆盖没有当天累计、三种依据、累计为 0、首次基线和无数量的“新”；类型检查、完整测试、隐私与构建见合并请求。页面样子没有变，没有重新截图；后端开关打开后在正式站点看一次。
