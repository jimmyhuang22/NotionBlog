# 持久发布与增量同步的备份恢复

这是新的独立发布模式的 owner 工具。旧 [网站 v2 归档](WEBSITE_DATABASE_RECOVERY.md)不能保存持久指针和操作账本，遇到这些扩展现在明确拒绝，不会遗漏后报告完整备份。旧核心／混合模式仍使用原工具。

## 范围

`src/server/database/publication-archive.ts` 的 `exportPublicationArchive` 先确定可选扩展，再用**单条 SQL 一致性快照**取得：

- 全部 v2 历史记录、正文、层级、媒体、政策、中央 deny、tombstone 和运行状态。
- 核心与可选自动学习迁移身份，持久发布指针及其迁移身份。
- 全部增量操作的身份、原载荷、回执与提交时间，增量及独立 reader 能力身份。
- 可选混合媒体来源索引，以及可选 v2 原有小图索引／派生对象描述。

必须已完整安装持久发布、增量提交和独立 reader。可选学习、混合媒体、小图扩展均严格验证对应摘要；未知版本、未知同族 namespace 或多余列拒绝。新归档格式 `notionblog-publication-archive-1` 与旧归档不互换。所有源身份、正文与操作载荷是私有数据。

v1 内容库与 v1 小图行不属于本归档，仍单独使用原备份；恢复不覆盖它们。SQL 函数、权限、角色／凭据、Auth、桶配置、Mac mini 队列、学习 checkpoint 和镜像缓存不在数据库 JSON 中。目标必须先安装相同源码迁移；本机状态与配置另行备份，不因数据库恢复而自动接续旧任务。

## 操作

下列是空示例；凭据用私有 env 文件，不放命令行。输出目录必须位于本检出的忽略 `.local/`，且不存在。

```sh
node --env-file=.local/backup-owner.env scripts/publication-database.ts export .local/backup/new-publication
node --env-file=.local/backup-owner.env scripts/publication-database.ts export .local/backup/new-with-media --media
node scripts/publication-database.ts verify .local/backup/new-with-media
node --env-file=.local/restore-owner.env scripts/publication-database.ts restore .local/backup/new-with-media
```

`verify` 完全离线，无数据库或 Notion 凭据要求。文件传输沿用 700／600、当前所有者、无软／硬链接、完成 manifest 最后写入及失败清理保护；校验内容和对象 SHA-256、大小及格式。归档上限总共 64 MiB／200,000 行，带文件时最多 10,000 去重对象／2 GiB，单对象沿用 20 MiB。操作载荷每项仍受原 100 数组项／16 MiB 约束；超限失败，不截断。

默认只备份元数据，明确 `mediaIncluded=false`。`--media` 包括历史原件与 v2 派生图，按对象摘要去重；既有存储字节直接读取和核验，不重压、不上传。历史 Notion-only 原件由旧 owner 备份适配器解析准确定位；此历史备份可能访问 Notion，访客路径仍独立。缺失历史对象或坏字节使备份失败，不能当作已完成。本文没有要求立即重读线上全图，真实备份应复用已验证私有副本并按实际预算执行。

## 恢复保护

`restorePublicationArchive` 在专用 owner 连接中持有原迁移 advisory lock，按固定顺序锁核心／发布／增量和可选索引表，最多等五秒。空库、全部扩展及摘要验证通过后才插入；任何晚期约束失败回滚全部内容、索引和状态。事务中没有文件读取或 Notion／Storage 请求。

恢复保留历史和操作账本，但清空两个发布指针与租约，revision／epoch／fence 递增，旧 run 有效期到期，staging 变为 failed。qualified 和 published reader 都不能服务历史内容。历史操作 lookup 仍能返回原回执供审计；它不是当前发布证明，也不能确认队列或重新发送已提交操作。

本工具不上传文件，不启用 provider、激活历史 run 或安装调度。恢复后重新核对当前来源政策，建立获准基线及对应新本机队列／checkpoint，再按独立模式验收发布。不能恢复 JSON 后直接接上旧未知提交队列，或把旧回执改成 readerVerified。

## 验证与剩余工作

PGlite 实际组合核心、自动学习、持久发布、增量、reader、混合媒体及小图迁移，验证全部数据与账本恢复、旧工具防遗漏、空目标／摘要／未知扩展拒绝、晚期 ledger 失败原子回滚、两种 reader 禁用、旧回执仅为历史、原件与 WebP 字节验证。未查询真实云库、读取真实图片或执行实际恢复。

当前增量仍在 PostgreSQL 内部复制未改行，历史规模会增长；本归档按实际上限明确失败。上线前需结合实际规模决定保留与流式备份方案，不能通过自动删旧历史掩盖容量问题。完整切换还包括本机队列／checkpoint 恢复、独立媒体、源端撤回及 Notion 断网验收。
