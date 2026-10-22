# 网站增量同步：持久队列基础

本模块负责本机变化提示、发现检查点和处理状态，不调用 Notion、发布数据库或图片存储，也没有安装 CLI、Webhook 或定时任务。当前完整发布与小图接续继续运行。[有界执行与单页准备](WEBSITE_INCREMENTAL_EXECUTOR.md)已绑定实际 SQL 与独立 reader，[变更发现](WEBSITE_INCREMENTAL_DISCOVERY.md)提供元数据目录；独立媒体、学习依赖及正式运行器仍需集成，不能把队列基础称为完成增量同步。

## 接入

`scripts/website-incremental-sync/queue.ts` 导出 `openIncrementalQueue(privateDirectory, scope, clock?)`，返回同步事务 API。scope 包含固定配置摘要与来源键集合；已有库与新摘要／来源集合不一致时停止，不能自动清空或解释为扩大授权。

内部使用仓库已有 Node 24 `node:sqlite`，无需新增依赖。私有目录与 `incremental.sqlite` 使用原私有路径验证和 600 文件权限，打开前核查 SQLite sidecar，不接受软链、硬链或公开文件。独立 application_id／schema version 防止在别的 SQLite 库里静默建表。v2 新增同库目录与扫描断点，v3 增加领域退役待办；v1／v2 原子升级保留已有队列和未知操作，见[变更发现](WEBSITE_INCREMENTAL_DISCOVERY.md)与[生命周期](WEBSITE_INCREMENTAL_LIFECYCLE.md)。

队列仅保存页面键、原因、代次、事件摘要、目录摘要／编辑时刻、游标和提交摘要，不保存正文、签名图片地址或云凭据。`status()` 只返回各状态与事件／检查点／retirement_pending 的数量，后续 Dashboard 适配器另做原子摘要输出。

## 发现与处理

- `enqueue(events)` 持久去重 Webhook／补查提示。同一页不同事件合并原因和增加代次；重复事件不新建任务，同事件键内容冲突则整事务失败。事件只提示变化，适配器必须读取最新实际状态，不按事件时间重放旧正文。
- `checkpoint()`／`commitDiscovery()` 将一页完整发现结果与下一游标一起提交，并检查预期检查点版本。分页失败不调用该提交；另一个发现者推进游标后，旧页提交全部回滚。
- `claim(limit, leaseMs)` 原子取得有限任务，返回独立 operationId 和本次代次。准备中又收到编辑时，新代次保留；旧任务完成后仍继续处理新代次。
- `retryPreparation()` 为尚未提交的准备失败设置显式延迟；租约过期的准备任务可重新取得，新 token 阻止旧进程确认或提交。
- `requireReview()` 暂停范围／来源身份等不确定任务，后续事件不能解除暂停。`resume()` 是操作方明确恢复动作，重新准备仍必须校验发布范围。

一个原始事件如果产生多个依赖页的提示，入口需用原事件身份、来源与页面生成各自稳定的提示键，例如三者的摘要；不能给不同页面复用同一个 eventId。只有验签／发现验证完成的提示才调用入队接口，本模块本身不接受外部 HTTP。

## 提交与崩溃恢复

准备数据与媒体后，调用 `markSubmitting(ticket, {payloadDigest, expectedRevision})`，先持久保存，再调用后续云端提交接口。该步骤之后不允许以租约过期、超时或进程重启为由重发。

`pendingVerifications()` 返回待核对操作。适配器以 operationId 查询服务器真实结果，并通过独立 reader 验证，再调用 `confirmCommit()`；operationId、payloadDigest 及 readerVerified 必须一致。处理期间有新编辑时，确认旧提交后仅完成旧代次。

明确服务器拒绝可调用 `confirmRejected()`，再按指定延迟重试。超时、查询没有结果或网络不可用都不是 definitive rejection；保持待核对，不能凭本机时间判断没有提交。无变化且尚未提交的任务可用 `completeUnchanged()`，前提是适配器已比较当前准备结果与其发布版本。

本模块只校验本地回执身份与状态，不能自行认证服务器 proof；云提交、结果查询和独立 reader 的真实验证由发布适配器负责。它还必须先完成政策、父链、正文、媒体就绪与撤回语义检查。

一个 ticket 对应一次发布操作，可以携带该页的必要依赖。多个 ticket 目前不能共享一个服务器 operationId；若后续需要多任务联合提交，应增加明确的分组回执接口，而不能分别伪造确认。

## 边界与后续

每次发现最多 200 个事件，claim／待核对列表最多 50 页，准备租约最多 15 分钟，显式重试延迟最多一天。范围变更需要明确建立匹配的新队列／基线，不能继续使用旧摘要。历史事件和尝试当前保留，不自动清理、归档或删除旧资产。

队列没有自动批量重试、后台线程、云查询、发布命令或排程切换。元数据扫描在独立 discovery 端口；下一阶段由正式运行器消费发现、内容、领域检查点与稳定媒体。真实接入时保留现有 canonical 锁和 Dagu 的发布后小图接续。
