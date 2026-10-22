# 网站内容能力与真实预览

普通图片已支持独立 Notion 动态交付，转换图片仍读 Storage；新鲜索引与同版本公开资格都必须通过。v2 启用迁移、配置、严格同步和回退顺序见 [混合媒体说明](HYBRID_MEDIA.md)。

这一版为关于页、作品库、项目类型和跨栏目查询提供后端入口。前端继续只读 `contracts/` 的 DTO 和 `src/lib/content/` 的统一服务。关于页和项目页面的视觉实现由前端接入；博客与项目的真实来源仍待用户提供。

## 版本与分工

现有 `notionblog-sync-v1`、核心迁移、原 worker 和恢复工具保持原协议。新内容使用显式选择的 `notionblog-website-v2`，表与函数分别在 `nb_v2`、`nb_v2_api`，不会修改或接管旧 lease、快照、策略和 checkpoint。不能把旧 worker 的暂存批次直接当成 v2 发布批次。

本轮新增 v2 来源解析、采集器、writer、reader、查询与验收工具。恢复任务继续负责 v1 导出恢复和全量发布验收；图片任务维护既有下载、HEIC、媒体响应与缓存约定。新采集器复用下载器，新图片路径复用原媒体的字节和撤回验证。

**切换 v2 前需要完整采集与发布所有启用来源，安装匹配的迁移和策略，再设置 `DATABASE_CONTENT_VERSION=2`。** 新格式不会静默读取 v1 或回退演示数据。旧归档工具只涵盖 v1；新版应用表及对象使用独立的 [v2 备份与恢复工具](WEBSITE_DATABASE_RECOVERY.md)。SQL 函数由匹配迁移安装；代表库及完整获准来源的本机空库恢复已验证，云端恢复仍须另行验收。

## 给前端的接口

| 需求 | 统一入口 | HTTP |
| --- | --- | --- |
| 动态排版预览 | `StatusEntry.previewBody? / previewBodyTruncated?`，授权后的有界文字块 | 动态列表与首页时间线同 DTO |
| 关于 | `contentRepository.getPage("about")` → `{slug,title,updatedAt,document}` 或 null | `GET /api/pages/about` |
| 首页时间线 | `getTimeline({limit?,cursor?})` → `TimelinePage` | `GET /api/timeline` |
| 搜索 | `search({q,kinds?,limit?,cursor?})` → `Page<SearchHit>` | `GET /api/search?q=…&kinds=post,game` |
| 列表与总数 | `list(kind, query)`；v2／Notion v2／mock 返回 `total` | 原有 `/api/content/[kind]` |
| 文章相邻项 | `get("post", slug).adjacent` → `{newer,older}`，各为 `{title,href}` 或 null | 原有详情接口 |
| 项目 | `Project`：`period,role,stack,links`；`list/get("project",…)` | 原有列表与详情接口 |
| B站合集播放 | `SocialTimelineWork.collection.latestMemberUrl / latestMemberLinkVerifiedAt`，最新可公开一集的已核验播放地址 | `/api/social/works-v2` 与 `/api/home/feed-v2` 共用 DTO |

合集链接取当前可公开且日期已知的最新成员，与封面成员回退共用排序；原合集地址保留作前端回退。多P沿用本视频地址。详情与演示支持、缺失值及日期口径见[合集播放链接](SOCIAL_COLLECTION_PLAYBACK.md)。

`limit` 为 1–50，默认 12。查询参数不得重复；非法查询为 400；未公开或不存在的详情／关于键为 404；读取、权限、资格过期或版本错误为受控 503。错误不会附带 SDK、数据库、来源配置或凭据细节。

时间线是当前公开记录的日期视图，按真实作品／体验日期排序；不会把 `updatedAt` 当作活动时间，也不会伪造过去的状态变更记录。状态类作品只产生对应当前状态的条目，愿望清单不产生体验事件。相同作品同一天合并为一个条目；未知日期保留 null 并排在末尾。完整事件形状见 `contracts/website.ts`。需要累计历史的后续版本须另外采集事件历史。

游戏事件（`game-playing`、`game-cleared`、`game-platinumed`）携带可选字段 `playedTime: TimeAmount | null`，值取当前公开 `Game.playedTime`，例如 `{value:120.25,unit:"hour"}`；未知为 null，真实零仍是 `{value:0,unit:"hour"}`。它表示当前累计时长，不表示事件当天的游玩量；不换算单位、不取整、不使用 `estimatedTime`。其他事件不增加该字段。数据库及演示 provider 共用生成逻辑，原日期、去重和分页规则不变。现有游戏 DTO 已有此值，无需新增来源读取或数据库迁移。

游标必须当成不透明字符串。时间线、搜索和 v2 列表绑定当前快照与查询；批次、公开资格、筛选、时区或页大小变化后返回 400，前端从第一页重新开始。搜索使用当前公开 DTO 和可读 AST 的文本，排除不可用内部链接的文字与 URL／图片地址；结果是纯文本摘要，无 HTML。v2 单次读取限制为 20,000 条／16 MiB，超限明确失败，不能截断后伪装成完整列表。

关于页只绑定固定 `about` 与一个精确页面标识，父级和子页不会因此获得公开资格。学习按新授权采用全部课程及拥有的多层后代自动公开，逐祖先验证物理归属与中央撤回；链接、关系、外部数据库视图与引用同步块不纳入。旧配置与冻结 v1 仍兼容名单；自动模式须安装独立学习扩展，见 [说明](STUDY_PUBLICATION.md)。作品、相册和博客只对用户明确指定的 data source 使用整来源模式，现有及未来新增直接记录自动纳入；移出来源、归档、删除或中央撤回的页面不进入新读取。

## 字段、公式和演示内容

新 Notion 来源文件采用 `schemaVersion: 2`；真实标识只放忽略目录或服务端环境变量。标题／状态／日期／评分／文件分别校验属性类型；状态标签通过 `statusMap` 显式映射。没有映射或未知值保留 null／unknown，不用状态当发布开关。

游戏手填时长的 `playedTimeUnit` 必须明确。可直接映射已维护的有效时长公式，也可显式映射平台／Steam 分钟值；真实 0 不触发历史值回退。发行日期、体验日期分别保存；奖杯和时长不推导剧情进度。关系／汇总必须保证 Integration 可读取相关来源，缺少统计时保留未知。

`TextRun.equation === true` 表示行内公式，`text` 是原表达式；新 Notion 适配与 v2 验证保留该标记，旧 v1 AST 保持兼容。前端可在服务端使用 `renderEquation(text, false)`，失败显示原文本。现有 RichText／展开动态的行内公式视觉接入由前端完成，不能将表达式直接作为 HTML。

演示数据包含 36 条动态、17 篇文章、16 个相册，以及超过两页的书籍／影视／游戏；有跨年、无日期、缺封面、长标题、空正文、代码、块与行内公式、嵌套学习笔记及多图相册。所有新增内容为虚构数据，不含真实来源或私人正文。

## 缓存、SEO 与 404

JSON、XML发现入口与错误继续no-store。用户2026-10-17同意[浏览器图片缓存一天](decisions/2026-10-17-private-media-cache-day.md)：成功的v2／社交站内图片字节响应使用private,max-age=86400,must-revalidate，CDN专用头明确no-store；不使用immutable。新服务器请求仍检查所有者资格、格式、大小、SHA和下载后撤回，访客已缓存的副本可在一天内复用，过期须重新验证。签名原图302跳转、404／权限／不可用继续no-store，冻结v1保持旧策略。页面五分钟缓存属于前端独立范围，本项不改变JSON／HTML缓存。

默认 `SITE_INDEXING_ENABLED=false`，演示和 Vercel Preview 始终不收录。站点地图、RSS 与根／详情元数据只有在真实 provider、明确开启收录并提供有效 HTTPS `SITE_URL` 时公开；`SITE_DISCOVERY_KINDS_JSON` 只列已实现路由的栏目，默认不列关于和项目。地图不包含动态片段、查询、媒体地址或关闭的栏目；RSS 只取已公开、已知日期的动态与文章。资格或 provider 失败时返回 503，不能生成看似成功的空地图。

内容详情在 Next.js Proxy 中先检查当前元数据，未知、关闭和无公开资格的详情在流式输出开始前改写到沿用现有界面的 404 入口。笔记也检查课程归属；原页面和 API 的资格检查保留。元数据失败保持服务器错误，不改成 404。验收分别检查实际页面状态码、noindex 和 API 状态，不将流式正文中的找不到提示当成状态码证明。

## 本机真实预览

现有获准来源已完成完整本机 v2 发布与全量 API 验收，包含真实作品、相册与关于单页；本机预览只使用受限 reader。实际数量、浏览器范围与云端尚未切换的边界见 [真实来源完整性验收](WEBSITE_SOURCE_ACCEPTANCE.md)。

需要 owner-only（600）只读环境文件，不能给 Next migration／writer 连接。工具只传递网站所需变量，绑定 loopback，强制关闭收录。真实源配置、站点身份与头像留忽略路径。

```sh
npm run dev:real -- --env /private/path/website-reader.env --port 3100
# 直接 Notion 读取只用于排查；数据库模式用于完整性能验收：
npm run dev:real -- --env /private/path/notion-reader.env --provider notion --sources /private/path/notion-website.json --port 3100
npm run website:capabilities -- http://127.0.0.1:3100
```

数据库 reader 文件设置 `CONTENT_PROVIDER=database`、`DATABASE_CONTENT_VERSION=2`、受限 `DATABASE_READER_URL`、TLS 与原私有对象存储 reader 参数。`CONTENT_FEATURES_JSON` 是公开布尔开关，例如 `{"game":true,"book":true,"movie":true,"album":true,"page":true}`；真实来源与公开资格仍由私有配置及数据库策略决定。博客／项目没有真实来源时继续关闭。

混合图片预览在同一私有 reader 文件设置 `MEDIA_PROVIDER=notion`，提供只读 Notion 连接及匹配的 v2 来源配置，并保留转换图所需的 Storage reader。启动器将该开关传给 Next，拒绝无效值；未设置时保留 Storage 默认行为。worker 的 `SYNC_MEDIA_PROVIDER`、migration／writer 连接不会传给预览进程。启动前仍须完成对应版本的完整发布和定位登记，单独设置开关不能补齐缺失索引。

仅隔离的 loopback 数据库可以配置 `DATABASE_MEDIA_DIRECTORY`，用于 owner-only 私有本机媒体；其 reader 无写入能力。云端继续使用既有私有对象存储，不可把本机目录配置用于远程数据库。

v2 运维入口是 `npm run website:sync -- <migrate|policy|dry-run|stage|publish|deny|allow>`，使用独立私有 `--env-file` 调用 Node；`policy` 必须明确设置 `SYNC_FRESHNESS_SECONDS`。`migrate/policy/deny/allow` 用 migration owner，`stage/publish` 用 `nb_writer`；这些命令只操作 v2。政策变化使旧批次失效，中央 deny 即刻影响新读取；允许列表缺页、权限失败、遍历截断或图片失败时不会发布不完整批次。`stage` 会释放 lease 并保留待查数据，不让网站读到该批次。

私有预览样本与全量发布配置必须分开；代表样本可以验收字段、正文、图片和网站连接，不能替代全来源发布、同步时效、备份恢复或中国内地／海外网络验收。正式发布、域名、云端迁移与 provider 切换仍按用户的独立指令执行。

可选 `getContentMetadata(kind, slug)` 不加载正文，Notion 也不登记封面。有效详情增加一次独立元数据检查，没有跨请求资格缓存。只读数据库预览、完整来源与云端分别验收；最新实际范围见 [真实来源完整性验收](WEBSITE_SOURCE_ACCEPTANCE.md)。
