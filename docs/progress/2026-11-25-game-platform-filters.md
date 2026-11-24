# 2026-11-25：游戏库平台筛选后端（Codex）

按 [后端交接第二十二节](../BACKEND_HANDOFF.md#二十二游戏库按平台筛选2026-11-24claude)实现。编辑范围包括查询契约、平台匹配、数据库和 Notion 读取路径、演示 fixtures 和相关回归测试。

## 前端接入

- `GET /api/content/game`、`GET /api/library/game/years` 和 `readLibraryFirstPage` 接受 `platform=switch|playstation|steam|pc`。旧平台名继续可用。Switch 合并 Switch、Switch 2、3DS。Steam 与 PC 各用自己的资料标签，多平台游戏可出现在多个类别。
- `GET /api/library/game/years` 的 `data` 和首屏结果的 `years` 增加可选字段 `platforms: { key: GamePlatformCategory; count: number }[]` 和 `platformTotal: number`。前者依次返回有游戏的 Switch、PlayStation、Steam、PC。`platformTotal` 给“全部”使用，包含当前状态下的未分类平台，并给每款游戏只计一次。
- `years` 数组和 `undatedCount` 按状态与平台统计。`platforms` 和 `platformTotal` 只按状态统计，切换平台或年份时可以继续用这两个字段。平台改变时重置列表游标。书籍和影视年份接口仍只接受 `status`。

## 验证与交接

按同一套规则覆盖了演示、Notion、已发布数据库的默认路径及精简首屏路径。年份查询继续在已具备资格的元数据上统计，SQL 投影只增加已有的平台字段。此项可随应用代码发布，无数据库迁移。前端接入平台分段、浮动坞与 URL 参数后复验各状态的年份和款数。正式发布后补记上海、新加坡的上线时间。

本机 Node 24 的 `npm run check` 通过 3,560 项测试，`npm run build`、构建隐私扫描和本机 HTTP 集成验证通过。PGlite 回归用实际读权限核对了年份接口、两条首屏路径、同类平台去重和撤回后的款数。使用离线演示和合成数据验收。
