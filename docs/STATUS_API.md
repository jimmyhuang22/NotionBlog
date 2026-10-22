# 动态列表与年份接口

状态：后端已实现，mock、Notion 和 database 使用同一列表 DTO。前端图片网格、展开按钮判断和年份选择仍需接入；本阶段未改界面。

## 前端调用

```ts
const page = await contentRepository.list("status", { limit: 12, year: 2026 });
const years = await contentRepository.getStatusYears();
```

浏览器使用以下地址，所有响应均为 `Cache-Control: no-store`：

- `GET /api/content/status?year=2026&limit=12`：指定年份。
- `GET /api/content/status?year=undated&limit=12`：没有日期的动态。
- `GET /api/content/status?limit=12`：全部动态，日期倒序，无日期在后。
- `GET /api/status/years`：完整可公开动态的年份数量；这个地址不占用动态详情路由，不接收查询参数。
- `GET /api/content/status/<slug>`：原有完整正文接口。

年份汇总使用正常 `data` 包装：

```json
{
  "data": {
    "years": [{ "year": 2026, "count": 12 }, { "year": 2025, "count": 8 }],
    "undatedCount": 2,
    "timeZone": "UTC"
  }
}
```

汇总统计所有当前合格动态，与列表的 `tag`、分页和年份选择无关；没有记录的年份不列出。无日期保持 null，只计入 `undatedCount`；选择一个数字年份时不包含这些记录。`year` 适用于 status 及影视、书籍、游戏的体验日期，接受 1–9999 的整数或 `undated`，无效、重复或不支持的参数返回 400。作品库的状态年份统计见 [作品库年份接口](LIBRARY_YEARS_API.md)；本动态统计地址的行为保持。

日期时间按私有站点配置的 `timeZone` 计算年份，与页面的 `dateParts` 一致；纯日期不换时区。例如 `2025-12-31T14:30:00Z` 在 Australia/Melbourne 属于 2026，而 `2025-12-31` 仍属于 2025。默认 UTC。切换年份、标签、分页大小、排序或站点时区需清空游标；数据库批次或公开政策更新也会使旧游标返回 400。

## 图片与展开按钮

Status 的列表项和首页汇总增加兼容的可选字段：

```ts
images?: ImageAsset[];
hasMoreBody?: boolean;
```

三个 provider 的列表都会填入它们。`images` 按 AST 正文顺序取前九张，遍历嵌套列表、折叠、提示块与分栏；不把页面封面当正文图片，不从正文 URL 猜图片。尺寸未知继续为 null。图片沿用现有媒体权限和刷新规则；数据库图片继续从站内 `/media/…` 读取。

`hasMoreBody=false` 只表示完整正文已经由列表文字和这些图片表达。结构块、图片说明、超过九张的图片、未包含在 `text` 的段落、partial 正文和未读取正文都保留 true。`text` 保持原有完整提取结果，完整text不作截断；另行新增的previewBody有独立预算，见下文。客户端如果另行截断文字，也需提供展开方式。旧适配器缺字段时应继续保留原展开行为。

完整详情保留原 DTO／AST，不增加上述列表派生字段，方便既有 worker 继续直接复用详情作为同步输入。新增字段只在列表读取时计算，先做当前链接／图片权限投影，再提取摘要；不要求 worker 增加字段或重做同步。

## 数据库读取扩展

冻结的 `notionblog-sync-v1`、核心 SQL 和 `schemaDigest` 均保持原值。网站单独新增 `notionblog-status-read-v1`，SQL 在 `database/reader-migrations/001_status.sql`，SHA-256 在 `database/reader-protocol.json`。

初次安装运行现有 `migrate` 会同时安装核心和 reader；已经安装核心的数据库可单独执行：

```sh
node --env-file=.local/database.env scripts/database.ts migrate-reader
node --env-file=.local/database.env scripts/database.ts verify
```

由原迁移 owner 执行，沿用会话锁、迁移摘要和登记；网站不自动迁移。新增两个函数只给 `nb_reader` 执行，writer、匿名和平台 API 角色不能访问。未安装或版本不匹配时返回受控 503，不回退到旧查询或 mock；核心 writer、详情和媒体函数仍保留。

SQL 在分页前过滤年份，汇总只读取当前合格元数据。数据库列表在服务端读取本页已存正文以计算图片摘要，返回客户端时仍只有列表 DTO；访客不访问 Notion。直接 Notion 模式仍只读取所选页的正文，年份汇总不读取正文或封面；上游延迟仍受 Notion 限制。真实云库、worker 和目标网络的性能需要后续联调。


## 收起状态的排版预览（F14）

列表、首页汇总和首页时间线中的 `StatusEntry` 可携带 `previewBody?: ContentBlock[]` 与 `previewBodyTruncated?: boolean`。它们由同一 `statusPreview` 在当前正文授权、链接与媒体脱敏之后派生；Notion、database 和 mock 一致。详情与存储／同步输入不带这两个字段，既有 schemaDigest、核心 SQL、采集与资格规则不改，无需为此重采正文。

预览按原 AST 顺序保留段落、标题、引用、提示、折叠、列表、分隔线和分栏，保留块 ID、文字格式与经过过滤的链接。图片仍只走原 images；代码块、显示公式、表格、书签、嵌入、子页和其他详情块不加入本预览。行内公式只有完整放得下时才保留，不截断表达式。总计最多400个Unicode码点、12个块／列表项节点、3层容器、40个非空文字片段，序列化blocks最多8KiB；先到任一上限停止，最后文字片段可截短，不切断UTF-16代理对。预览是有界文字序列，不保证在每种字体／宽度恰好九行。

短的单个纯文字段落省略预览字段。出现结构、有效行内格式、多段落或预算截断时提供预览；没有可显示文字类块时也省略。不加载正文时不会沿用旧preview字段。`previewBodyTruncated`表示预览预算截断了可显示内容；被明确排除的图片／代码等仍由原hasMoreBody表示。

`text`仍是完整提取结果，`hasMoreBody`语义不变。因此长纯文字的hasMoreBody可能仍是false，而previewBodyTruncated是true；前端展开判断须同时考虑这两个信息及自身九行裁切。底部渐隐、九行、点击展开属于前端，后端不输出HTML或控制样式。旧前端可忽略新可选字段。
