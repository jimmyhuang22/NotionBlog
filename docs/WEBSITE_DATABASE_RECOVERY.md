# 网站 v2 备份与恢复

适用于 `notionblog-website-v2` 的原核心／混合模式；原同步 v1 继续使用 [原版恢复流程](DATABASE_RECOVERY.md)。已安装自动学习、持久发布或增量扩展时使用[新的持久发布恢复工具](PUBLICATION_RECOVERY.md)，旧工具明确拒绝，避免遗漏发布指针或操作账本。各格式不互换，不改变冻结迁移、网站权限或原同步运行根。

同时支持核心对象存储与已安装的混合媒体扩展。核心库保持 `notionblog-website-archive-1`；安装匹配的 `nb_v2_media`／`nb_v2_media_api` 后导出 `notionblog-website-archive-2`，包含全部历史来源定位表与独立媒体迁移摘要。未知 namespace、未完成安装或迁移错配仍拒绝，不能遗漏扩展后报告完整备份。两种归档只恢复到安装了对应迁移的初始空库。

## 备份范围

`website:database` 使用 migration owner 的专用连接；网站 reader／同步 writer 没有导出私有表的权限。先只读识别扩展，再通过单条 SQL 的一致性快照包含 `nb_v2` 的 state、sources、permits、denied、runs、records、media、tombstones，以及可选 `nb_v2_media.sources`，保留全部历史批次、正文、层级、中央撤回、对象描述与定位。协议、schema 摘要、核心及媒体迁移摘要同时核对。

使用 `--media` 才会另外读取所有历史描述引用的去重图片，并核对格式、大小和 SHA256。存在普通图定位时，重新从 Notion 读取准确页面／块／文件属性，检查归属、签名有效期与来源 fingerprint，再通过现有安全下载器保存对应字节；只刷新临时签名不视为源改变。仅 Storage 交付的转换图与旧对象从私有存储读取。来源变化、删除、归属变化、字节改变或历史对象缺失同样失败，不会忽略或用占位完成备份。

没有此参数的备份明确标记 `mediaIncluded=false`，只包含数据库与可选定位表。历史与当前引用共用相同哈希时只保存一份字节，可由档案中明确登记的有效定位提供；定位不等于图片文件。SQL 备份本身不包含 Storage 对象，参见 [Supabase 备份说明](https://supabase.com/docs/guides/platform/backups)。

备份不包含数据库角色／密码、Notion Token、Auth 用户、Storage 桶设置或 SQL 函数。目标库先从仓库安装匹配迁移；凭据和服务配置另行私有保存。函数与权限来自迁移，不能从归档覆盖。

## 操作

在项目检出根目录执行。备份必须位于该检出的忽略目录 `.local/`，所有路径祖先拒绝符号链接，私有目录／文件分别要求 700／600 与当前所有者。以下名称都是空示例，真实文件不得提交：

```sh
node --env-file=.local/backup-reader.env scripts/website-database.ts export .local/backup/new-bundle --media
node scripts/website-database.ts verify .local/backup/new-bundle
node --env-file=.local/restore-owner.env scripts/website-sync/cli.ts migrate
# 仅 archive-2：目标空库还需安装对应媒体扩展
node --env-file=.local/restore-owner.env scripts/website-sync/cli.ts migrate-media
node --env-file=.local/restore-owner.env scripts/website-database.ts restore .local/backup/new-bundle
```

数据库连接使用 `DATABASE_MIGRATION_URL` 和显式 TLS 设置。普通图备份使用原只读 `NOTION_TOKEN`／可选 `NOTION_API_VERSION`，按归档定位读取，无需另给网站来源映射或写入权限；它是私有历史字节备份，不是公开资格检查，不用于网站媒体接口。Storage 图使用受限 reader 的 `STORAGE_URL`、`STORAGE_BUCKET`、`STORAGE_API_KEY`、`STORAGE_READ_TOKEN`；不要提供写入 Token。凭据按实际图片类型延迟初始化，纯 Notion 图不要求 Storage，原核心存储备份不要求 Notion。隔离本机样本可以设置 `DATABASE_MEDIA_DIRECTORY`，但数据库必须为 loopback。

`npm run website:database -- <export|verify|restore> <目录>` 是同一入口；通过 Node `--env-file` 加载秘密，避免命令行和日志出现连接串。`verify` 完全离线，不连接数据库，重新读取归档及全部已备份图片。输出只包含聚合数量，原始异常保持隐藏。

输出目录必须不存在；不覆盖已有备份。`content.json` 保存完整数据库，`sha256/` 保存可选对象，`manifest.json` 最后写入，包含版本、字节数与摘要。中途失败删除本次新建的不完整目录。摘要用于发现传输损坏，不是来源真实性签名；备份仍须放在可信私有存储。

明确上限：归档 64 MiB／合计 200,000 行；图片最多 10,000 个去重对象／2 GiB，每个沿用现有 20 MiB 上限；manifest 2 MiB。超限直接失败，不截断。更大规模需要另行设计流式备份，不能用网站单次读取上限替代完整备份范围。

## 恢复保护与重新发布

仅恢复到匹配迁移的全新空库：七张策略／内容表及可选来源定位表全部为空，state 为初始无政策、无指针、无租约状态。外层协议／迁移、内部唯一 state、完整列集合和安全整数均须匹配；定位逐项核对 run、asset、owner、SHA、locator 身份、交付类型及 fingerprint，未知或缺失字段不会被静默丢弃。archive-1 不会自动升级或抹掉目标媒体扩展。

恢复前先验证文件及已保存的全部图片字节；事务内按固定顺序锁定核心表、来源定位表和迁移登记，阻止空库检查后插入其他数据。所有插入、约束和安全状态变更在同一专用连接完成；中途或提交时的约束失败全部回滚，锁等待最多五秒。事务中没有 Notion／Storage 网络调用或文件读取。

恢复保留内容和政策，但清空发布／租约指针，revision、epoch、fence 各增加一次，使全部旧 run 的有效期失效，并将 staging 改为 failed。网站 reader 必须明确拒绝；不能因恢复把历史资格重新激活，也不会回退 mock。

本工具**不上传或覆盖图片**。带图片的备份可以离线核验和私有保管；重新接入目标存储、Auth／Storage 设置恢复与托管云库恢复另行验收。保存的是网站实际交付的普通原图及转换后图片，不包含转换前 HEIC/HEIF 原件。重新提供网站内容必须核对最新 Notion 资格、安装当前政策并完整重新采集发布；不得 promote 恢复的历史 run。来源政策仍由原配置决定，恢复不扩大公开范围。

## 已验证边界

- 2026-10-12 完整获准来源的本机 archive-2：1,248 条内容、1,828 个媒体引用／定位行、1,785 个去重图片对象，共 1,382,248,397 图片字节及 5,649,386 数据库字节；完整文件保存和离线逐字节核验通过。1,559 张普通原图重新经公有 v2 安全下载器取得；223 个同 SHA 原封面复用已完成原字节审计的文件，但逐对象重新读取当前 Notion 原生定位、匹配不可变文件 fingerprint；外链不从检查点复用。三张转换图从私有本机存储读取，不包含转换前 HEIC 原件。
- 上述完整归档恢复到匹配冻结核心／媒体迁移的新建空 PostgreSQL。政策、正文、媒体等表及全部 1,828 个定位行逐项一致；安全状态按规则改变，旧批次过期、发布／租约指针清空，reader 明确拒绝。原发布库前后摘要一致，临时恢复库已删除。
- 首次完整归档在 Notion 页面读取失败后严格终止，未完成目录按设计清理，未进入恢复；原异常经过既有 client 屏蔽，不能推断其具体网络码。成功的私有运维运行对可确认的网络／网关故障作有界重试，实际恢复一次 Notion 读取，权限、证书、格式及未知失败不额外重试。每个去重普通对象使用有效定位，不声称全部重复／历史定位都实时读取；全部定位行仍完整备份和恢复比较。冗余字节检查点在成功后清理，完整归档和原封面审计保留。
- 合成数据覆盖全部内容类型、已发布／失败／暂存历史、政策／撤回／正文／媒体／tombstone；逐表恢复，仅安全状态改变。reader／writer 不能导出，原 namespace 不受影响。
- 实际隔离 PostgreSQL 使用真实代表库：5 条内容、4 个历史 run、16 个媒体引用／15 个去重对象；约 43 MB 原图字节逐个复核。源库前后摘要一致，临时恢复库已清理。
- 空库恢复、非空及 deny-only 目标拒绝、迁移错配拒绝、延迟外键失败原子回滚、并发写入阻塞、恢复后 reader 拒绝均通过；文件篡改、错误图片和符号链接拒绝。
- 混合合成链路覆盖普通 Notion 原图与 Storage 转换图、两个历史批次、cover／block／files-property 定位及签名刷新；来源变化、过期、移走、坏字节与非预期转换拒绝。定位表提交时的延迟失败整批回滚；相同哈希的旧无索引引用仍可由明确有效的 Notion 定位备份。
- 实际混合 v2 本机采集五个真实代表页：16 媒体引用／16 定位、15 张普通原图共 42,677,192 字节，单独取回并离线 CLI 校验。新 PostgreSQL 空库的核心／定位逐项一致，定位并发写入被阻止，定位提交失败整批回滚；原样本库不变，临时库已清理。本组没有转换图，Storage 转换交付由上面的合成链路验证。

这证明工具、代表数据及完整获准来源的本机备份／空库恢复链路；完整本机发布与网站读取见 [真实来源验收](WEBSITE_SOURCE_ACCEPTANCE.md)。云端迁移／托管恢复、持续同步、正式发布和跨地区访问仍未完成，不能用本机回执替代。
