# 数据库读取与同步协议 v1

状态：本地 SQL、权限、provider 和存储边界已实现；真实云连接与上游同步任务尚未验收。网站入口和所有公共 DTO 保持兼容。当前实际运行来源不自动切换。

## 文件与版本

- `contracts/sync.ts`：服务端／worker 类型，`SYNC_PROTOCOL`、`SYNC_SCHEMA_DIGEST`。
- `database/migrations/001_content.sql`：标准 PostgreSQL，私有 `nb` 表和 `nb_api` 函数。
- `database/reader-migrations/`、`reader-protocol.json`：兼容的站点读取扩展与独立摘要，不改变冻结的 worker 握手。当前增加 Status 图片摘要／年份查询，见 [读取说明](STATUS_API.md)。
- `database/protocol.json`：迁移 SHA-256 与协议摘要；双方使用同一提交及锁文件。`npm run database:protocol` 校验实际 SQL。
- `src/server/database/writer.ts`：可直接在独立 Node.js CLI 导入的 writer，接受 `SqlExecutor`，不读取环境、不导入 `server-only`。
- `repository.ts`：保持 `ContentRepository`；`storage.ts`：可替换的对象存储端口与固定 Storage HTTP adapter；`archive.ts`：私有导出恢复。

应用、worker 和数据库必须匹配协议摘要。writer begin、网站内容读取和媒体读取均检查版本；不匹配返回受控错误。已应用的迁移不可原地编辑；后续发布新增编号迁移、更新 manifest 并协调协议版本。首次冻结前更新 manifest 可运行 `node scripts/check-database-protocol.ts --write`。

## 权限与配置

迁移只创建 `nb_reader`、`nb_writer` NOLOGIN 角色。管理员另外创建两套独立 LOGIN，分别授予这一个角色，不给表权限、CREATE、其他角色、超级用户或 BYPASSRLS。迁移 owner 只用于管理 CLI。reader 只能调用两个核心读取函数及已安装的两个 Status 读取函数，writer 只能调用五个批次函数；两者都不能直接访问私有表或改公开规则。私有表启用 RLS，无匿名策略；已有 `anon`、`authenticated`、`service_role` 的本工程权限显式撤销。

网站设置 `CONTENT_PROVIDER=database`、`DATABASE_READER_URL`；TLS 默认验证证书，可通过 `DATABASE_CA_CERT` 配置信任链。连接串不接受附加参数，禁止绕过证书校验；`DATABASE_TLS=disable` 只允许本地回环测试。网站连接池最多两条连接，连接与查询有超时。writer 使用自己私有的连接串；迁移连接不能部署到网站。

管理员的私有 `.local/database.env` 至少有 `DATABASE_MIGRATION_URL` 和 `DATABASE_TLS=verify`。先手动应用迁移，再安装私有策略：

```sh
node --env-file=.local/database.env scripts/database.ts migrate
node --env-file=.local/database.env scripts/database.ts verify
node --env-file=.local/database.env scripts/database.ts policy .local/publication-policy.json
```

migrate 同时安装核心与独立 reader；已安装核心可只运行 migrate-reader，详情见 [动态接口](STATUS_API.md)。脚本验证迁移文件摘要，使用会话锁，已应用的相同迁移可重复执行；不在启动网站或构建时执行迁移。不打印连接串、来源标识或驱动错误。

## 策略输入与资格

`PublicationPolicy` 包含 `configDigest`、显式 `freshnessSeconds`、`sources` 和 `permits`。摘要统一用 `configDigest(parseNotionSourcesConfig(privateInput))` 计算，字段映射、来源、媒体策略和名单都包含在摘要内。TTL 范围为 1–86400 秒，需要管理员明确填写；测试值不代表真实发布时效已决定。

每个 source 保存原配置的 key、kind、mode、规范化 dataSourceId。学习来源的 `databaseParentId` 是 `data_source.database_parent` 的包含页面，必须等于选中课程页面；块父级先解析到页面。Status 只接指定来源的 mode=all。课程和笔记逐个出现在 permits 中，不能用完成状态作开关。

permits 的课程行 `courseId=null,parentId=null`。笔记行保存固定 courseId 和最近的父页面 ID；顶层笔记在策略／evidence 中的 parentId 是课程 ID，但公共 `StudyNote.parentId` 仍为 null，保留现有 DTO。更深笔记两处 parentId 相同。同课程笔记的祖先必须来自同一学习来源。SQL 拒绝缺父、错课程、错来源与循环。

worker 复用 Notion repository 独立验证当前活动状态、直属来源、schema、名单和完整父链，验证成功后才生成 evidence。数据库无法独立证明 Notion 当前状态，不能用任意 JSON 或曾经同步过的 ID 代替实时资格校验。管理员策略整理和源端资格发现是不同动作。

完整政策修改会增加 epoch 和 revision，使旧快照不可读，直到完整新批次发布。中央拒绝名单不因新政策安装而清空。紧急下架及恢复由管理员执行：

```sh
node --env-file=.local/database.env scripts/database.ts deny <canonical-page-id>
node --env-file=.local/database.env scripts/database.ts allow <canonical-page-id>
```

下架课程／父笔记会阻断所有后代、目录、进入这些页面的内部链接和归属图片。此操作增加 revision，终止旧 lease；worker 无权清除拒绝名单。allow 是明确重新许可，现有已存内容可能重新可见，必须由管理员使用。

## writer 生命周期

```ts
const writer = createDatabaseWriter(sqlExecutor);
const lease = await writer.begin(runUuid, configDigest, 300);
await writer.stage(lease, qualifiedRecords, uploadedMedia);
await writer.renew(lease, 300);
await writer.promote(lease, { records: totalRecords, media: totalAssets, complete: true });
// 失败时：await writer.fail(lease)
```

1. begin 校验协议／schema／配置摘要，领取全局数据库 lease，返回 fence、revision 和 `deniedPageIds`。有效 lease 阻止其他 run；同一 run 重试 begin 返回相同资格。超时接管会增加 fence，旧进程不能 stage、renew 或 promote。
2. stage 每批最多 100 records、100 media、100 absences，总 JSON 不超过 16 MB，在同一个事务中校验并幂等 upsert。record 仅包含经过转换的 DTO、AST 与 evidence，不接受 SDK 属性或临时媒体地址。ordinal 用于保留课程目录顺序。对象先上传成功，再登记 descriptor；owner 必须已在当前批次中暂存，可先 stage records 后单独 stage media。
3. worker 根据中央拒绝名单排除页面及其全部后代。其余 allowlist 页必须全部入批；新增未批准学习页不入批。首版是完整快照，不是仅发送变更的增量更新。
4. 只有所有分页、正文与对象处理完成后，才以实际去重后的 record／asset 数及 complete=true 提交 receipt。SQL 检查计数、当前 lease／revision、完整父链、允许节点、非 null 正文，以及每个图片引用的当前页归属。partial AST 仍标为 partial；网络／权限失败不能冒充合法空库。名单中已确认 archived／deleted／out-of-scope 的页面通过 stage 第四个参数写 ConfirmedAbsence，receipt.confirmedAbsent 提供数量（默认 0）；确认移除父页同时排除其全部后代。当前原始元数据须明确证明移除状态，404／权限失败／超时不能写 absence；没有解释的缺页继续拒绝 promote。
5. promote 在短事务中改 current_run 指针。失败／半批次保持原指针；已成功的同一次 promote 可重试。旧 lease 的 fail 不能释放新 lease。运行记录保存开始／结束、状态及计数，不保存上游错误正文。任务自己的采样 checkpoint 必须在 promote 成功后推进。

允许存在未被 AST 引用的已登记图片；不允许 AST 引用不存在或别页拥有的图片。临时孤立对象由另行实现的回收任务处理，必须保护当前与保留批次；首版不自动删除对象或历史批次。

## 读取、缓存与时效

`CONTENT_PROVIDER=database` 仍通过 `src/lib/content/index.ts`，保持 list、get、getHome、getCourseMetadata、getCourseTree。首版导入 status/course/study-note；其他类型仍禁用且没有真实导入能力。Status 列表在服务端读取本页已存正文以派生图片摘要，其他列表不读正文，课程树从当前合格笔记的 parentId 重建，详情读取完整已存 AST；访客请求不调用 Notion。

分页游标绑定过滤、排序、limit、run 和 revision。批次切换／撤回后旧游标返回 INVALID_QUERY，现有前端会重取第一页。日期排序使用真实记录日期，未知始终在末尾；同时间按标题／ID 稳定排序。课程排序默认按标题；目录按 ordinal。单棵树上限 5000 个合格节点，超过时明确失败。

首阶段页面、API、媒体继续动态且 no-store。完整快照的有效期从 begin 开始计算，renew 不延长资格 TTL；过期、缺批次、策略 epoch 变化或数据库失败返回 CONTENT_UNAVAILABLE，不能回退 mock 或合法空内容。源端撤回要等同步发现，中央 deny 则阻断之后的读取；已完成的响应／下载无法追回。具体同步周期与可接受延迟需要在真实切换前确认。

## 媒体与 Storage adapter

worker 使用 `mediaIdentity(ownerPageId, locator, sha256)` 生成 `a1.<hash>`，locator 对封面／property／block 使用稳定规范值；内容改变时新 hash 对应新 ID。对象键为 `sha256/<file-sha256>`，AST 永远使用 `/media/<assetId>`。descriptor 保存 owner、哈希、大小、MIME 和尺寸；未知尺寸为 null。

`ObjectStorage.read/put` 可换其他供应商。Storage adapter 只请求固定的 HTTPS `/storage/v1` endpoint 和安全对象键，拒绝重定向，限制 20 MB／20 秒，校验字节数、哈希与图片签名。put 禁止 upsert，冲突后读取并核对现有字节；拒绝使用 broad service_role／secret key。

可选 `database/storage-policies.sql` 创建或复用配置一致的私有 `notionblog-media` bucket（不覆盖已有设置）；只给 authenticated JWT 的可信 `app_metadata.notionblog_storage_role=reader` 或 writer 读取权限，writer 可新增，不可 UPDATE／DELETE。网站需要 publishable／anon API key 和单独 reader JWT；worker 使用 writer JWT。JWT 的签名／身份验证由 Storage 执行；角色元数据由管理员设定，不能来自用户可写的 user_metadata。网站可配置专用 reader 账户在服务端复核身份并更新短期 access token，不共享 writer 的 refresh token；静态 JWT 仍支持但需单独更新。实现与预检见[网站读库接入](WEBSITE_DATABASE_SETUP.md)，不能把离线结果或测试 token 当实际凭据验收。应用前复核已有全局 Storage 策略，禁止匿名直接读 bucket。[私有桶](https://supabase.com/docs/guides/storage/buckets/fundamentals)、[Storage 权限](https://supabase.com/docs/guides/storage/security/access-control)。

网站读 descriptor 时先检查当前合格 owner，取完字节再检查一次，在本站响应实际文件和 no-store/nosniff，不向浏览器暴露供应商地址／令牌。文件会经过网站服务端，流量与内存成本仍需测量。

上游下载器由 worker 实现：协议、目标 DNS／IP（含 IPv6）、每次重定向、凭据、metadata／内网目标、超时、大小和类型都要检查。本 adapter 不负责抓取任意 Notion URL，不能把固定存储端点测试当作下载器 SSRF 已验收。

## 导出、恢复与验证边界

逐项验收、空库／事务边界及图片备份分工见 [内容数据库恢复流程](DATABASE_RECOVERY.md)。

```sh
node --env-file=.local/database.env scripts/database.ts export .local/backup-new --media
node --env-file=.local/database.env scripts/database.ts restore .local/backup-new --media
```

导出一次一致性 SQL 快照及单独对象字节，私有 content.json 和文件采用 600 权限；目录 700，已有输出不覆盖。不加 --media 只有数据库与对象清单，没有实际图片。restore 只接受同协议的空迁移库；历史正文／政策恢复后 current_run 仍为空、资格过期，必须重新检查政策和完整同步，不能把旧资格重新发布。对象文件经哈希验证再上传。外部 PostgreSQL 可使用同一 SQL、角色和标准 pg 驱动；这不替代云端备份演练。

本地使用 PGlite 执行 PostgreSQL SQL、角色、父链、lease、版本、撤回、分页和恢复测试；Storage RLS 测试执行真实策略文件，但 auth／storage schema 为最小模型；HTTP 存储请求注入虚构响应。未验证托管数据库网络、证书、真实 JWT／Storage、多人连接竞争、真实 worker、目标网络速度或云端导出恢复。[PGlite API](https://pglite.dev/docs/api)、[PostgreSQL 安全函数](https://www.postgresql.org/docs/current/sql-createfunction.html)、[pg TLS](https://node-postgres.com/features/ssl)。
