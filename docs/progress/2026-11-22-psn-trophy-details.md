# 2026-11-22：PSN 逐个奖杯与站内图标（Codex）

基于 `573eda1` 落实 [#416](https://github.com/jimmyhuang22/NotionBlog/pull/416) 第十八节甲组和第十六节第二步。`ContentDetail.trophySets[].trophies` 是可选的完整列表。字段为 `id`、`name`、`detail`、`grade`、`icon`、`earned`、`earnedDate`、`rarityPercent`、`hidden`，沿用前端字段。游戏详情和对应 API 提供，列表和首页沿用原数据。演示库各套补齐，并含零获得和未获得的隐藏奖杯。

沿用本人身份、显式作品绑定、平台可见性与排除名单。分别读取奖杯定义和本人获得状态，检查完整分页、版本、ID 与等级计数。获得日按运行者明确提供的站点 IANA 时区转为日期，比例保留一位小数。未获得的隐藏奖杯在读取图标前已抹去名称、说明和图标来源。原图字节和宽高在验证后进入网站数据库，独立的 `/media/v2/trophy/[assetId]` 使用现役发布资格提供原尺寸，响应为 `private, no-store`。缺图回 `null`。旧链接在游戏撤回、奖杯隐藏或移出新快照后不可读。

后续获准安装时，先按序装本扩展目录的 `001` 和 `002`（已有 `001` 的数据库只增装 `002`），再使用现有游戏私有目录运行 `collect-psn-trophy-details <private-dir> <site-time-zone>` 和 `apply-psn-trophy-details <private-dir>`。复用相同账户锁和一小时快照时效。每个图标至多 256 KiB，图标下载总量上限 64 MiB，私有快照上限 96 MiB，均是上限而非真实用量。新导入与统计同一事务。旧统计导入仍可使用，会移除旧详情，接上新入口后沿用新入口更新。双站各自的数据库安装及数据交付须在发布前单独核对。

Node 24.22.1 的 `npm run check` 3,518 项通过，`npm run build`、52 项产物隐私追踪与本机自托管冒烟通过。本机 PGlite 核对角色隔离、逐套完整性、写入回滚、旧快照拒绝、原图字节和游戏撤回后的旧地址。初次检查发现媒体兼容性固定了原路由，改为独立媒体路由后复查通过。验证仅使用离线演示和合成奖杯。没有安装正式数据库扩展、批量采集 PSN 或上传图标。Steam 单独核对。在发布 [#409](https://github.com/jimmyhuang22/NotionBlog/pull/409) 打开期间，改动留在工作分支。
