# 社交作品只读接口（云端 reader 已验收，展示默认关闭）

采集与上传见 [采集说明](SOCIAL_SYNC.md)及[受限上传](SOCIAL_CLOUD.md)。本层将同一 `workId` 的获准发布聚合为一张作品，各平台统计分别保留。前端只消费 [DTO](../contracts/social.ts)和 `src/lib/content/social.ts`，不读取采集器、SQLite、原始负载或凭据。

## 状态与接口

独立 SQL 迁移、reader、DTO 与 GET 接口已实现。首次安装被自动审批拒绝后，用户明确批准 nb_social_reader、social_sync 内受 RLS 限制的 SELECT、外置 SSD 私有密码及事务内回滚样本读取；实际安装和验收现已完成。五条已有观测仍未公开，作品与逐发布资格表均为空，不配置 Vercel或部署；本机网站已实际用新 reader 读到当前空集合。

`GET /api/social/works?limit=12&cursor=...` 返回 `{data:{items,total,hasMore,nextCursor}}`。每项包含 `id/type/title/occurredAt/cover/publications`；`type=social-work`，平台当前仅 B 站／小红书。一到二十条发布组成一个作品，一次 SQL 使用同一快照读取资格、编辑信息和采样。最多五百个作品／8MiB 投影，聚合前限定五百零一件与每件二十一条作为溢出哨兵，超限明确失败；每页默认十二、最大二十，日期降序、无日期末尾、同日期按作品键排序。游标不透明，内容或资格变化后客户端重置首批。此扩容不改变 RLS、资格或协议，也没有接入新的 [合集候选 DTO](SOCIAL_COLLECTIONS.md)。

默认 `SOCIAL_PROVIDER=disabled`，404 且不查库；显式 database 缺配置、迁移、权限或查询失败为 503，不回退 mock。与现有 CONTENT_PROVIDER 独立，不修改原首页时间线契约、栏目开关、provider 或页面。全部响应 `private, no-store`／`noindex, nofollow`；不返回账号 ID、正文、评论文本或响应摘要。没有写入 HTTP 接口，现阶段 `cover=null`，未接社交媒体下载／代理／缩略图。

## 已安装权限及资格

官方 CLI 生成的 additive reader 迁移在上传迁移后安装；版本已对齐实际云端历史，文件为 `20261012015408_social_reader_v1.sql`，SQL 不因文件名改变。只增加 social_sync 内的 reader_meta／works／website_visibility、invoker 视图及 reader SELECT policy 和辅助逻辑，不改冻结内容／媒体协议或旧登录。另以 `20261012020551_social_reader_binding_index.sql` 补齐新表复合外键索引，不重写已安装迁移。

- 新 nb_social_reader 默认 NOLOGIN，无继承、角色成员、高权或 RLS 绕过；迁移的初始连接限四、事务默认只读。既有运行库的连接限额按下方独立操作记录调整，旧迁移不重写。独立密码仅服务端使用，配置函数不给 worker／reader EXECUTE。
- reader 只获新对象 SELECT、旧绑定必要三列和最新发布必要四列 SELECT；现有表仍有 RLS，仅能读启用绑定、逐发布资格及作品批准同时成立的行。旧 nb 内容 schema、写入／删除／审批／上传／凭据函数不开放。匿名、authenticated、service_role 及旧 reader 无新权限。
- works.approved 和 website_visibility.approved 默认 false。采集绑定启用或新发布加入已有作品不授予展示资格；采集器不能批准。上传 payload 的 websitePublicationApproved=false 保持，网站资格独立存储。
- 临时联调规则为逐发布检查后最多二十四小时，过期／撤销停止返回，采样也须在二十四小时内；不改旧采样时间。该窗口不是已冻结的长期政策，续期／采集任务未安装。
- 日期来自明确的作品编辑／发布日期，缺失 null，不以采集或修改时刻代替；分组沿用明确 workId，不猜测同名关联。

**已批准并完成**：在现有试验 Supabase 安装上述角色及受限对象，生成独立密码仅留忽略的外置 SSD 验收目录，临时密码交接文件验收后删除。默认不批准作品，不配置 Vercel、部署或启用首页；所有临时样本资格与绑定更改已回滚，没有公开整账号。

服务端配置为 SOCIAL_PROVIDER、SOCIAL_READER_DATABASE_URL、SOCIAL_READER_DATABASE_TLS=verify、SOCIAL_READER_DATABASE_CA_CERT；URL 用户只允许 nb_social_reader（含 pooler 后缀），拒绝 URL 查询参数覆盖 TLS。沿用 pg，连接生命周期使用固定的官方辅助库；不要复用 uploader／旧网站 reader／postgres 凭据。

## 连接池与故障诊断

社交 reader 保留模块全局 Pool、每进程最多两个连接，空闲五秒关闭。创建时使用固定 `@vercel/functions@3.9.11` 的 `attachDatabasePool`，通过平台 waitUntil 等待 pg 的空闲清理，避免响应结束后实例暂停使清理定时器停住；活动连接不强制关闭，不逐请求创建／结束整个池。该官方 API 仍标有 Experimental，版本固定并验证实际 pg Pool 的释放行为。其他内容 provider、同步 worker 和权限校验不变。原理见 [Vercel 官方连接池说明](https://vercel.com/kb/guide/connection-pooling-with-functions)。

驱动查询与空闲池错误记录固定事件 `social_reader_database_error`、阶段 `query`／`idle_pool` 和 SQLSTATE／已知网络错误码。未识别的码记为 UNKNOWN，不记录错误消息、完整对象、SQL、参数、连接 URL 或正文。公共 HTTP 仍返回原有脱敏 503，不重试查询、不缓存旧资格、不回退 mock，也不自动隐藏社交后返回一个不完整首页。

2026-10-13 已确认既有运行库出现该角色的 FATAL 53300（角色连接不足）。用户单独批准后，以即时原限额及整库容量门槛将该库的角色连接上限从四调整到十六，读回确认；登录、默认只读、高权与角色成员均保持。此项是单独云配置操作，不是新迁移，不会由 Git 合并或运行器自动应用到其他库。余量不能保证任意水平扩容均成功，后续以自然访问的限定日志观察；session pooler 地址未切换。回滚限额只影响新连接，也会恢复此前容量不足风险，不自动终止既有连接。具体状态和验证边界见 [本项记录](progress/2026-10-13-social-reader-connection-lifecycle.md)。

## 链接、统计与前端交接

B 站仅接受相应 BV 的 HTTPS 标准地址。小红书仅接受相应笔记实际“复制链接”产生的 discovery/item webshare 地址及公开分享参数，拒绝任意跳转、不同笔记、会话参数、用户名密码及片段；与无参数 explore 身份地址分开。未检查地址保持 null，前端不补猜 URL。分享 token 是平台提供的公开链接参数，不是 Cookie；完整个人链接只留私人证据。链接核验距本次资格检查最多五分钟，延长资格需重验链接。

实际一个小红书图文分享地址在当前登录 Chrome 打开同一笔记与评论；无 Cookie HTTP 转登录，未直接获得笔记。原平台可能要求登录；匿名可看、真机及长期有效性未证明。实际小红书样本仍是图文，视频未验收。

七种 exact 指标与 display 分开；未知 null、真实零 0，小红书 1.2万 不转整数。播放／投币／弹幕未知，单稿／单笔记 scope 保留，不跨平台求和成统一热度。图文 image-note 与 video 分开。Claude 后续制作一张作品卡片及平台统计行；评论仅显示数量，非空 originalUrl 才跳平台，注明可能需登录。首页混排、分页衔接、视觉方案与封面另行接入，后端完成不等于页面已出现。

测试覆盖聚合、null／零／近似、无日期、RLS／invoker、逐发布批准、撤销／过期、旧采样不能复活、禁用不查库、HTTP 错误脱敏和游标失效。完整检查与构建见 [进度](PROGRESS.md)。

## 实际云端验收与边界

- 新独立登录身份／无继承及角色成员／reader 协议／默认只读均通过；客户端 TLS socket 实际 encrypted／authorized 为 true，证书校验保持开启。连接池后端 pg_stat_ssl 为 false，不用它推断客户端证书验证，首轮测试的错误判断保留私人记录。
- 当前空集合：实际 reader 查不到发布及绑定，生产 HTTP 两次 GET 为 200／零作品，非法页大小 400、POST 405；GET 保持 private／no-store／noindex。本机测试进程已停止。九项写入／审批／列权限／上传／凭据／旧 writer 新对象读取拒绝通过；reader 不能使用旧 nb schema，原 uploader 协议及五条记录保持。
- 一次样本事务在实际 SQL reader 角色下读到五观测／五作品；撤销作品可见零，撤销一个绑定可见四，资格过期可见零。数据库管理员创建新角色时自动取得 ADMIN，但 SET 默认为 false；仅在样本事务内临时启用其现有关系的 SET，使用异常子事务回滚所有资格、绑定及成员选项。结束后作品／资格为零，成员选项、五条完整源记录与绑定原样。会话临时 helper 使用 SECURITY INVOKER，不增永久高权函数。
- 实际 reader SQL 投影再经过生产 DTO／HTTP handler，与本地五条采样的标题、日期、平台、类型、时间和统计逐项匹配，私有字段排除。该正向 handler 是已回滚 SQL 结果的私有重放；独立登录的实际网站 HTTP 只读到当前空集合，不声称永久批准样本后的页面已上线。回读未重新采集、改旧时间、确认待传或续期网站旧批次。
- 五条上传 payload 摘要及二十五张旧应用表计数保持；不把计数核对写成旧业务表逐字节审计。新社交域没有安全 advisor 项，新增缺外键索引 INFO 已用独立迁移修复；空表／小集合保留的索引仍可能有 [unused index INFO](https://supabase.com/docs/guides/database/database-linter?lint=0005_unused_index)，不为消掉诊断而删必要索引。旧域诊断不在本轮修改。

限制：页面卡片、持久作品展示资格、社交封面、Vercel reader 配置、跨地区／真机和持续运行仍未接入；下一项按已有前端分工准备卡片及选定作品的受控本机预览，不自动公开整账号或安装调度。

依据：[Supabase invoker 视图](https://supabase.com/docs/guides/database/views)、[RLS](https://supabase.com/docs/guides/database/postgres/row-level-security)、[Postgres GRANT](https://www.postgresql.org/docs/current/sql-grant.html)。
