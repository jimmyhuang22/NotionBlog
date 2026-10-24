# 增量运行程序的读写连接

`src/server/database/incremental-connection.ts` 提供后台程序的实际 PostgreSQL 连接绑定。它复用已有 pg、显式 TLS 与小连接池，把独立 reader 和 writer 接入已合并的提交／按页读取／发布确认接口；不创建账号、改权限、安装迁移、激活发布或启动调度。

## 接入

```ts
const binding = await openIncrementalDatabase({
  readerUrl, writerUrl, configDigest, tls: "verify", ca,
}, {}, signal);
try {
  // 公共执行器可接 createDatabasePublicationPort(binding.writer, binding.reader)
  // 内容准备可接 createDatabasePublishedPageReader(binding.reader)
  // binding.publisher 提供 state / publish / lookup；readPage / verify 为独立 reader。
} finally {
  await binding.close();
}
```

输入显式提供，模块没有共享 env、管理员连接、网站连接或 mock 的默认回退。返回对象和私有投影只供后台，不能给浏览器。失败只暴露稳定码，不转发 driver 消息或连接串。提交／恢复继续使用原 UUID 与摘要，没有重试循环；调用方仍须持有 canonical 同步互斥锁，并先持久记录提交状态。

两条连接必须是不同 LOGIN，指向同一主机、端口、数据库及相同池租户。程序读取双方的当前发布版本、配置／schema 摘要与政策 epoch，确认与本次私有来源配置一致。直接端点与池端点混用会拒绝；后台可使用独立、匹配的 reader 配置，不自动借用网站端的另一池模式。

## 权限核验

同步使用的 `nb_delta_reader`、`nb_writer` 是 **NOLOGIN 权限角色**；实际连接使用仅继承相应角色的独立 LOGIN。启动时通过 PostgreSQL 目录核对实际登录身份，不能仅相信 URL 用户名：

- 实际 LOGIN 与 session 身份一致，无 superuser、BYPASSRLS、建库、建角色或 replication 权限。
- 成员图仅含对应 NOLOGIN 角色，无另一组、其他继承组或成员管理权限。
- 无数据库／项目 schema 创建或所有权、项目函数所有权、私有表／列／视图／序列直接权限。
- 必需增量 API 存在且可执行；可达的项目函数必须经相应权限组明确授予。额外直接函数授权、PUBLIC 泄漏或政策管理授权拒绝。

保留已批准的 writer 发布能力；不会把权限角色改成可登录账号，也不撤销合法的旧发布／媒体 API。权限发生漂移时停止，由管理者核对，不自动 GRANT。连接方式参考 [Supabase PostgreSQL 连接说明](https://supabase.com/docs/guides/database/connecting-to-postgres)，身份与角色语义参考 [PostgreSQL 角色](https://www.postgresql.org/docs/current/database-roles.html)。

## 只读运行前检查

```sh
node --env-file=.local/incremental-runtime.env scripts/verify-incremental-database.ts
```

使用新 `SYNC_READER_DATABASE_URL` 与现有 `SYNC_DATABASE_URL`、`DATABASE_TLS`／可选 `DATABASE_CA_CERT`。`NOTION_SOURCES_JSON` 与 `NOTION_SOURCES_CONFIG` 二选一，用现有 v2 配置解析和摘要算法；只读本机配置，不访问 Notion。没有默认路径、凭据或端点；真实值只在受保护 env 中。

该命令检查角色、安装能力与**已接受的发布基线**，只输出汇总布尔值和零来源请求／零变更；不读取全库正文或对象。不完整的扩展、不同来源配置、未建立基线、版本变化或权限错配都不能报告可运行。每次检查完关闭两个池；分配失败和关闭异常也处理两个池，不留下后台任务。线上 TLS 默认验证证书，明文只允许已有规则支持的 loopback 隔离环境。

## 验证边界

PGlite 实际安装发布与增量／reader 迁移，通过独立 LOGIN 及继承角色执行提交、lookup、单页读取和独立确认；不是只按名称模拟权限。18 项定点测试覆盖越权成员、列／账本权限、额外函数、组政策授权、schema 所有权、管理员、PUBLIC 泄漏、缺 API、不同端点／池租户、scope／版本错配、取消和两池清理。

测试传输是显式 PGlite seam，验证了 SQL 权限与池配置，不代表真实 TCP、DNS、TLS 或云连接已验收。Supabase 当前 changelog 的 PostgreSQL 扩展修复不涉及本模块未使用的 ltree／pgcrypto PGP／btree_gist；HTTP TLS 变更也不作为放松证书验证的理由。没有修改云设置或安装登录账号。

完整运行还需公共发现／队列、学习可恢复检查点、非学习入链缓存和独立媒体准备。把这些接口接到同一互斥运行器后，再做指定变化与撤回、断电恢复和 Notion 隔离验收；本连接绑定不是新的定时任务已上线。
