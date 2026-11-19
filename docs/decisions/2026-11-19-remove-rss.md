# 2026-11-19：移除网站 RSS

状态：已采纳。用户要求移除网站的 RSS 订阅，由 Claude 实现；Codex 整理了交接（[移除 RSS 的交接](../progress/2026-11-19-footer-rss-removal-handoff.md)）。

## 决定

- 删掉页脚的“订阅”、`/feed.xml` 接口和页面里的 RSS 自动发现声明（根页面与详情页的 `application/rss+xml`）。
- 旧地址 `/feed.xml` 走应用默认的 404；已订阅的阅读器从此收不到本站更新。
- 站点地图、`robots.txt`、详情页的 canonical、分享卡片（Open Graph）和收录规则不变。
- 原实现见 2026-10-11 `35eadcb`（接口）与 2026-10-12 `7ee314d`（页脚），历史记录保留。
