# 网站增量同步：持久队列基础

本模块负责本机变化提示、发现检查点和处理状态，不调用 Notion、发布数据库或图片存储，也没有安装 CLI、Webhook 或定时任务。当前完整发布与小图接续继续运行。[有界执行与单页准备](WEBSITE_INCREMENTAL_EXECUTOR.md)已绑定实际 SQL 与独立 reader，[变更发现](WEBSITE_INCREMENTAL_DISCOVERY.md)提供元数据目录；独立媒体、学习依赖及正式运行器仍需集成，不能把队列基础称为完成增量同步。

## 接入

`scripts/website-incremental-sync/queue.ts` 导出 `openIncrementalQueue(privateDirectory, scope, clock?)`，返回同步事务 API。scope 包含固定配置摘要与来源键集合；已有库与新摘要／来源集合不一致时停止，不能自动清空或解释为扩大授权。

内部使用仓库已有 Node 24 `node:sqlite`，无需新增依赖。私有目录与 `incremental.sqlite` 使用原私有路径验证和 600 文件权限，打开前核查 SQLite sidecar，不接受软链、硬链或公开文件。独立 application_id／schema version 防止在别的 SQLite 库里静默建表。v2 新增同库目录与扫描断点，v3 增加领域退役待办，v4 增加目录基线，v5 增加历史回收索引；v1–v4 原子升级到 v5 时保留已有队列和未知操作，见[变更发现](WEBSITE_INCREMENTAL_DISCOVERY.md)与[生命周期](WEBSITE_INCREMENTAL_LIFECYCLE.md)。

队列仅保存页面键、原因、代次、事件摘要、目录摘要／编辑时刻、游标和提交摘要，不保存正文、签名图片地址或云凭据。`status()` 只返回各状态与事件／检查点／retirement_pending 的数量，后续 Dashboard 适配器另做原子摘要输出。

## 发现与处理

- `enqueue(events)` 持久去重 Webhook／补查提示。同一页不同事件合并原因和增加代次；重复事件不新建任务，同事件键内容冲突则整事务失败。事件只提示变化，适配器必须读取最新实际状态，不按事件时间重放旧正文。
- `checkpoint()`／`commitDiscovery()` 将一页完整发现结果与下一游标一起提交，并检查预期检查点版本。分页失败不调用该提交；另一个发现者推进游标后，旧页提交全部回滚。
- `claim(limit, leaseMs)` 原子取得有限任务，返回独立 operationId 和本次代次。准备中又收到编辑时，新代次保留；旧任务完成后仍继续处理新代次。
- `retryPreparation()` 为尚未提交的准备失败设置显式延迟；租约过期的准备任务可重新取得，新 token 阻止旧进程确认或提交。
- `requireReview()` 暂停范围／来源身份等不确定任务，后续事件不能解除暂停。`resume()` 是操作方明确恢复动作，重新准备仍必须校验发布范围。

一个原始事件如果产生多个依赖页的提示，入口需用原事件身份、来源与页面生成各自稳定的提示键，例如三者的摘要；eventId 在同一个队列库内全局唯一，不能给不同来源或页面复用同一个 eventId。重送同一事件还须保留原 observedAt：事件摘要包含 sourceKey、pageKey、reason、observedAt，改用本次接收时间会触发 QUEUE_EVENT_CONFLICT。只有验签／发现验证完成的提示才调用入队接口，本模块本身不接受外部 HTTP。

## 提交与崩溃恢复

准备数据与媒体后，调用 `markSubmitting(ticket, {payloadDigest, expectedRevision})`，先持久保存，再调用后续云端提交接口。该步骤之后不允许以租约过期、超时或进程重启为由重发。

`pendingVerifications()` 返回待核对操作。适配器以 operationId 查询服务器真实结果，并通过独立 reader 验证，再调用 `confirmCommit()`；operationId、payloadDigest 及 readerVerified 必须一致。处理期间有新编辑时，确认旧提交后仅完成旧代次。

明确服务器拒绝可调用 `confirmRejected()`，再按指定延迟重试。超时、查询没有结果或网络不可用都不是 definitive rejection；保持待核对，不能凭本机时间判断没有提交。无变化且尚未提交的任务可用 `completeUnchanged()`，前提是适配器已比较当前准备结果与其发布版本。

本模块只校验本地回执身份与状态，不能自行认证服务器 proof；云提交、结果查询和独立 reader 的真实验证由发布适配器负责。它还必须先完成政策、父链、正文、媒体就绪与撤回语义检查。

一个 ticket 对应一次发布操作，可以携带该页的必要依赖。多个 ticket 目前不能共享一个服务器 operationId；若后续需要多任务联合提交，应增加明确的分组回执接口，而不能分别伪造确认。

## 历史回收与事件去重边界

当前 v5 的实现见 [queue.ts](../scripts/website-incremental-sync/queue.ts)。不同记录的保留规则如下：

| 记录 | 当前行为 | 必须保留的范围 |
| --- | --- | --- |
| `attempts` 与关联 `retirements` | `compactHistory()` 默认每次选取最多 200 条旧尝试；显式 limit 为 1–1,000。执行器走到正常结果汇总前调用一次，不是独立定时清理任务 | 只回收早于该页 completed_generation、非活动且状态为 failed／abandoned／verified 的尝试；须收尾已确认，或为没有 retirement 的已验证真实提交。最后一次真实提交证明、当前完成代次及之后的失败计数、未知提交和未确认收尾均保留 |
| 内置目录扫描、缺失核对、学习子页提示 | 目录元数据／版本或 `commitLocalDiscovery()` 将提示与游标原子提交，不新增永久 events 行；旧版本重交被检查点拒绝 | 仍检查已有同名事件的摘要冲突；不能把内部发现接口当成任意外部事件的免去重入口 |
| 通用 `enqueue()`、带事件的 `commitDiscovery()` | 将 eventId 与摘要持久写入 events；相同 ID／摘要重送不增加任务，冲突则整事务回滚 | 当前没有过期、归档或删除接口，历史外部及旧内部 events 均保留 |

回收尝试不会清除事件身份：旧事件在回收后、重开队列后仍须去重或拒绝冲突。现有[队列回归](../tests/website-incremental-queue.test.ts)覆盖这些规则，[目录回归](../tests/website-incremental-discovery.test.ts)覆盖多轮变化不增加外部事件账本。本说明复核既有实现，不代表本轮重新执行测试或处理真实队列。

`enqueue()` 返回只表示本机事务完成，不表示上游已 ACK 或承诺不再重放。events 表只有 id／digest，不能从摘要还原来源、时间或所属检查点；目录扫描 watermark、jobs.completed_generation 和某个检查点 revision 都不是混合历史 events 的安全删除线。按天数、行数或“页面已发布”直接删除，会让旧事件再次被当作新提示，或丢失同 ID 冲突检测。

本轮仓库静态复核未发现调用该队列 `enqueue()` 的生产外部接入器；host 与学习发现的通用 `commitDiscovery()` 调用只传空事件。此结论限于仓库源码，不证明真实旧目录为空或外部私人程序不存在。当前无需新增通用归档系统。以后确有外部生产者接入时，应先针对该生产者明确稳定身份、重送字段、可验证的重放截止／ACK／epoch 规则及故障恢复行为，再审阅最小持久去重与回收方案；这些要求尚未实现为新协议。

已有 `status().events` 可提供事件数，但数量不证明可安全删除，也不反映数据库文件大小。只有在另行获准的真实目录检查中才能确认存量；本轮没有打开、升级、回收或 VACUUM 真实队列。SQLite 删除后页面可复用，不等于文件缩小。B15 保持部分交付，详见[本次复核](progress/2026-10-25-event-retention-boundary.md)。

## 边界与后续

每次发现最多 200 个事件，claim／待核对列表最多 50 页，准备租约最多 15 分钟，显式重试延迟最多一天。范围变更需要明确建立匹配的新队列／基线，不能继续使用旧摘要。历史记录按上节规则保留或有界回收；不自动归档 events，也不删除旧资产。

队列没有自动批量重试、后台线程、云查询、发布命令或排程切换。元数据扫描在独立 discovery 端口；下一阶段由正式运行器消费发现、内容、领域检查点与稳定媒体。真实接入时保留现有 canonical 锁和 Dagu 的发布后小图接续。
