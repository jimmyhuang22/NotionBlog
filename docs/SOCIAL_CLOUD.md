# 社交数据受限云端上传

`scripts/social-sync/cloud.ts` 为独立运行的 SQL 发送器，接在本地 SQLite 队列后。采集输入见 [社交程序](SOCIAL_SYNC.md)，网站契约和既有 Notion／媒体／网站同步协议保持。没有新增生产依赖、网站路由或常驻服务。

## 数据与权限

独立 `social_sync` schema 包含三表：

| 表 | 用途 | worker 能力 |
| --- | --- | --- |
| `meta` | 社交协议版本，目前为 1 | 只读握手 |
| `bindings` | 平台／作者／发布／作品关联及启用资格 | 只读启用绑定，不能登记或修改 |
| `publications` | 每次发布的最新观测和原始负载摘要 | 读取启用发布，写入必要列，不能删除 |

绑定默认停用，操作者只登记明确指定的发布；同一作品可在多个平台共用 `work_id`，身份和统计分别保存。生成的发布键与本地一致，复合外键防止改变作品关联，关联变更流程另行实现。停用绑定后，worker 看不到该发布且不能确认重试；云端记录留作私有恢复材料。云端只保留最新投影，本地历史继续完整保存，不上传历史队列或评论正文。

专用 `nb_social_worker` 无 superuser、bypassrls、createrole、createdb、replication 或角色继承能力，最多两条连接。所有表启用 RLS，`PUBLIC`、`anon`、`authenticated`、`service_role` 没有新 schema、表和函数权限；网站 reader 不提权。RLS 基于启用发布允许列表，不使用浏览器 JWT、可修改的用户 metadata 或伪造 session setting 授权。

写入函数为 **SECURITY INVOKER**；worker 必需的表列权限也受 RLS、身份／字段约束和单调时间触发器约束，不能通过直接 SQL 改绑定、删除数据、设置公开标志或绕过格式规则。没有添加特权函数绕过 RLS。限制原理参考 [RLS](https://supabase.com/docs/guides/database/postgres/row-level-security)和 [函数执行权限](https://supabase.com/docs/guides/troubleshooting/how-can-i-revoke-execution-of-a-postgresql-function-2GYb0A)。

## 初次安装

新增 migration 是 [social_sync_v1](../supabase/migrations/20261012005001_social_sync_v1.sql)。文件先由官方 CLI `migration new` 生成；MCP 安装时生成的远端 history 版本不同，已只读核对并将文件名对齐该实际版本。SQL 包含自己的事务，拒绝覆盖已经存在的同名 schema 或角色。它不改既有 schema、默认公共权限或冻结摘要，不应对同一目标反复安装。

角色初始 NOLOGIN。操作者使用受保护的参数化连接调用 `social_sync.configure_password($1)` 设置独立随机密码后开启登录；该函数仅操作者可执行，本身为 INVOKER，不赋予调用者新权限。密码须为 48–128 位 URL 安全字符，生成并保存于私有文件，不能写进 migration、Git 或普通输出。不要把网站 reader、Notion worker 或 Supabase service secret 作为社交登录。

操作者按实际私有配置登记绑定。下面仅为虚构示例：

```sql
insert into social_sync.bindings(platform,account_id,publication_id,work_id,enabled)
values ('bilibili','10001','BV0000000001','example-work',true);
```

真实平台、作者、发布键、目标数据库及凭据不进入公共文档。执行设备私有目录的 `cloud.env` 只接受 `SOCIAL_DATABASE_URL`、`DATABASE_TLS`、`DATABASE_CA_CERT`，文件 600、目录 700，不接受符号链接。开发和本轮联调在外置 SSD；固定内置运行 release、私有输入安装与周期任务仍另行验收。

## 上传与回执

```sh
node scripts/social-sync/cli.ts upload /ABSOLUTE/PRIVATE/social-sync
node scripts/social-sync/cli.ts status /ABSOLUTE/PRIVATE/social-sync
```

连接沿用既有严格 TLS helper，远端证书验证不能关闭，连接串不能通过 `sslmode` 查询参数改保护。发送器仅允许专用用户名（兼容 Supabase pooler 的项目后缀）；握手要求当前 SQL 角色与会话登录均为 `nb_social_worker`、协议 1 且无特权。不会刷新任何 Storage／网站／Notion worker 会话。

上传先校验完整观测、发布键和队列 SHA，原始 JSON 最大 192KiB；服务器再校验输入字节 SHA、精确字段、计数、平台类型、身份、URL 与绑定。B 站 v1 和小红书 v2 都保留，不混入统计范围；近似显示值的精确计数保持 null，未知日期与零不互相代替。服务器拒绝远未来三十秒以上的观察时间，收到数据的时间不代替实际观察时间。

`social_sync.ingest` 使用逐发布事务锁序列化初次写入及重试，当前记录只接受更新的观察时间。同时间同摘要／同内容返回已有回执；同时间不同内容或较旧数据拒绝。服务器只返回实际保存的发布键与摘要；网络中断、提交后丢回执或错误响应不会确认队列，重试能恢复。旧的在途回执也不能确认较新的排队样本。

发送器单连接逐条调用，服务器十秒／客户端十二秒 SQL 超时，CLI 整轮两分钟取消。收到中断后停止后续项，已在服务器完成但尚未确认的项留本地重试。移出本地配置的 pending 项报告 `skipped`、不发送、退出非零，不静默清除历史目标。

`latest-upload.json` 只记录本轮匿名计数和时间，数据库错误正文、凭据、标题、作者或负载不写入常规日志。状态里的 pending 零表示该本地队列已确认，不证明下一轮采集新鲜、原平台完整历史或网站公开资格。

## 本轮验收与剩余范围

- 现有试验库实际安装独立 schema／角色并登记五个指定样本；正式 CLI 首次确认五条，真实 B 站重新采集三个样本后确认三个更新，再执行 upload 确认零条。新本地验收库五发布／八历史采样／零待传，原两份采集验收库保留。
- 专用登录通过 TLS 和身份握手；云端五份最新投影与本地内容、SHA 完全一致。两个原生并行重复回执一致，八项错误摘要／旧时间／未注册／公开标志／绑定写入／删除／旧库读取／凭据修改拒绝均不改云记录。旧 v1／v2 状态和计数前后相同。
- 新增十四项离线角色与协议回归，包含实际数据库提交后丢响应再重试；整合同期变更后 Node24 完整 **783 项**、类型／三项协议／349 候选隐私与生产构建通过，Node26 的 **50 项**社交测试通过。私有数据、凭据和详细回执留忽略目录。
- 社交域没有新增安全诊断；作品分组索引在当前五行数据上尚未被使用，属于保留给下一阶段读取的 [unused-index INFO](https://supabase.com/docs/guides/database/database-linter?lint=0005_unused_index)，不当作权限错误。旧域诊断不在本轮修改范围。

所有 `websitePublicationApproved` 仍为 false，没有网站读取授权、页面卡片、调度、服务安装或 Vercel 部署。小红书输入仍需获准浏览器会话，真实视频和无人值守未通过；其无访问参数的规范链接实测不可读，实际网站分享／评论跳转还须验证。下一阶段先确定有效链接与只读发布资格，再接统一网站入口和时间线 DTO。
