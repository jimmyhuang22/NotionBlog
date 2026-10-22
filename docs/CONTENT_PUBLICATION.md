# 独立持久发布

用户已确认保留 Notion 编辑入口，把网站访问逐步移到自有数据库与独立对象交付。这一阶段增加持久发布基础，默认仍为原来的 `qualified` 模式，没有安装云迁移、改动周期任务或切换网站环境。

## 两种模式

| 模式 | 展示来源 | 同步有效期到期 | 发布切换 |
| --- | --- | --- | --- |
| `qualified`（默认） | 冻结 v2 的当前合格批次 | 拒绝读取 | 原来的完整同步 |
| `published`（可选） | 独立发布指针指定的完整批次 | 已显式发布的数据继续读取 | 完整同步与指针激活在同一事务中完成 |

新模式不是把旧迁移的有效期删除。它使用独立 `nb_publication`／`nb_publication_api`，冻结 v1/v2 文件、DTO 和前端入口不变。安装扩展不会选择任何旧批次；第一次激活只能采用当前、完整、已验证且仍有效的批次。后续普通 `qualified` 同步不会自动更新独立指针。

政策 epoch 或来源配置摘要变化后仍拒绝旧内容，需重新验证并显式完整发布。中央 deny 与课程祖先撤回仍逐次执行；搜索、目录、内部链接及媒体一并按资格过滤。失败的暂存、网络故障或不完整批次不会替换上一发布。重复提交不重置原发布时间。

## 开发与后续切换顺序

以下是待验收流程，不是已执行的线上操作。真实凭据、配置与回执只保存在私有文件中。

1. 用匹配的 v2 基础及独立迁移权限执行 `npm run website:sync -- migrate-publication`。程序核对本地迁移摘要和数据库基础，再安装并登记扩展；回执明确 `publicationActivated: false`。该命令不能调用普通网站 reader／writer 凭据。
2. 完成独立原图、小图交付及源端撤回验收，准备新的冻结 Mac mini release。保留既有镜像与对象，通过实际字节和来源核验复用，不能为了本阶段再次下载全库媒体。
3. 在新 release 的私有 worker 环境选择 `SYNC_PUBLICATION_MODE=published`、`SYNC_MEDIA_PROVIDER=storage`。先用固定入口 `--check` 离线检查；安装本身不启动 worker。标准 `website:sync` CLI 同样支持这两个选项。
4. 显式完整发布一次。原完整暂存／范围／正文／媒体检查先通过，随后服务器原子更新 qualified 与 persistent 两个指针；激活失败会回滚本次 promotion。固定入口使用新模式的 reader 回读 runId 和 schemaDigest，并把模式写入私有回执，不能把忽略新选项的旧 child 当作成功。
5. 网站采用 `CONTENT_PROVIDER=database`、`DATABASE_CONTENT_VERSION=2`、`DATABASE_PUBLICATION_MODE=published`、`MEDIA_PROVIDER=storage`。存储 reader 与 writer 仍分别授权。published 配合 Notion 动态媒体会明确拒绝，避免误称网站已独立。阻断 Notion 网络，验证代表页面、目录、搜索与图片后，再走 develop → main 发布流程。

不指定新选项时，网站和标准 CLI 保留原 `qualified` 逻辑；Mac mini 固定入口还保留其既有 Notion 混合媒体默认值，qualified 不采用共享 v1 环境中可能已有的 `SYNC_MEDIA_PROVIDER=storage`。切回 qualified 不会删除持久指针、历史批次或对象，但 qualified 的四小时限制会重新适用，切换前须确保新鲜批次。

## 权限与验证

新 schema 不暴露给 Supabase 匿名 REST API。reader 仅可查能力及内容／快照／媒体投影，writer 仅可查能力和显式激活／原子发布；两者都不能直接读取状态表或变更政策。匿名、认证与 service_role 的宽泛默认表／函数授权会在迁移内移除。服务端只替换固定 reader SQL 名称，参数和公开 DTO 保持不变。

PGlite 使用真实冻结迁移与新 SQL 验证：安装不激活、旧模式到期拒绝、新模式到期可读、实际存储图片、读取期间撤回、权限分离、重复提交、原子回滚、不完整批次保留上一版、分页游标与政策变更。固定入口测试验证显式选项传递、旧 child 回执拒绝及旧 release 拒绝；没有调用真实来源或云数据库。

## 当前限制与下一阶段

本阶段仍整批读取来源与正文；它不提供页面变化队列或 Notion Webhook。Notion 的删除、移出来源和权限异常尚未有独立的持久模式处理器，不能承诺新的自动撤回时限；中央 deny 可以立即停止网站投影读取。上线前要完成该处理器并区分明确删除与临时连接失败。

现有小图入口仅在混合 Notion 媒体路径使用，published + storage 当前读取已保存原件。独立小图登记、CDN 签名交付与缓存刷新是下一阶段，不能直接切到本模式并宣称图片加速完成。当前原件代理仍是 `private, no-store`，测试可用性不代替国内／海外性能测量。

现有 v2 归档保留内容与媒体历史，不包含新持久指针和发布时间；恢复保持不公开，不能复活旧指针。正式启用前须扩展备份登记及恢复流程；清理历史批次时不得删除被新指针引用的 run。数据库迁移安装和实际配置切换仍是独立操作，本次代码合并不执行它们。
