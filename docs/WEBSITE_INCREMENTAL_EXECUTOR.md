# 网站增量执行与单页内容准备

本阶段提供可注入端口的有界执行器和实际 Notion 单页转换适配，不安装周期任务、不默认读取私有环境或连接云服务。公共队列见 [队列说明](WEBSITE_INCREMENTAL_QUEUE.md)。发布 SQL、媒体存储和学习目录依赖由各自模块接入，不能把离线端口验证当作真实增量同步已运行。

## 执行顺序

`runIncrementalCycle(options, ports)` 默认最多 20 个任务、120 秒；最多允许 50 个任务、899 秒。内置超时和外部 AbortSignal 都会取消等待，结束时清理计时器；端口仍须遵守信号、释放其连接和实际传输，正式运行器还需原 canonical 互斥与进程清理。

1. 先查询队列里的未知提交，按 operationId／payloadDigest 查服务器结果并独立读回。查不到不是“未提交”的证明；尚有未知提交时不启动新发布，避免与全局发布版本交错。
2. 每次只 claim 一个任务，读取当前发布状态，检查配置／schema，再准备该页及必要依赖。读取状态失败不访问该页。
3. 无变化就完成本地代次；媒体等待或读取时再编辑则延迟重试。范围／政策未知则需要审查，不猜测删除或公开权限。
4. 准备的配置与预期版本须匹配当前状态。先持久化提交身份，再发出云端操作；成功回复还须由独立 reader 确认。
5. 明确版本冲突／busy 可留到下一轮重试；政策或输入拒绝进入 needs_review。网络错误、超时、响应缺失、错误提交身份或读回失败保持待核对，不盲重发。

结果只有 outcome、计数、稳定错误码和队列状态，不含页面键、正文、SQL 错误原文或签名媒体地址。任务上限结束可能返回 partial；它表示还有工作，不是全库发布完成。不会在同一轮反复重试一个失败任务，即使调用方把重试延迟设为零。

## 接入端口

- `prepare(ticket, state, signal)`：生成 prepared delta、unchanged、retry 或 review。实际内容、媒体与依赖都在这一阶段完成；执行器不隐式调用完整 worker。
- `createIncrementalPublicationPort(publisher, verifyReader)`：结构上对接主发布模块的 state／lookup／publish 方法，仅识别该模块明确的拒绝错误；其他错误保留未知状态。没有复制 SQL 或默认数据库连接。
- `finalize(receipt, signal)`：学习等领域适配器在独立读回后原子保存本机检查点，之后才确认队列。保存失败保持待核对，恢复时按同 operationId 再核对／保存，不重新采集或提交；准备结果及 next 检查点应先按操作身份持久保存，finalize 必须可幂等恢复。
- `retire(proof, signal)`：队列持久关闭未发送准备或明确拒绝后，幂等释放领域准备；失败保留待办并阻止新准备，不对未知提交或已应用检查点调用。详见[生命周期](WEBSITE_INCREMENTAL_LIFECYCLE.md)，退役也计入每轮动作预算。
- `prepareSinglePage()`／`createSinglePagePreparationPort()`：复用现有单页范围判断、正文 AST 和验证规则，取得一个完整准备结果，之后由主发布模块提供的 prepareDelta 验证／计算提交摘要。

发布 transport 与 prepareDelta 现已对接独立的增量发布 helper，见[增量发布协议](INCREMENTAL_PUBLICATION.md)。`createDatabasePublicationPort(writer, reader)` 绑定实际提交 helper 与 `verifyPublishedDelta`，`createDatabasePublishedPageReader(reader)` 绑定受限单页私有投影；详见[增量 reader](INCREMENTAL_READER.md)。没有默认连接或环境读取，各 helper 仍核对 capability。调用方负责真实连接的角色／TLS；writer 凭据不能替代 reader，私有证据投影不能给浏览器。

## 单页内容与媒体

Notion repository 新增 `collectRecord(id, {kind, ordinal, denied})`。它复用已有单 owner／物理祖先校验和 item／document／hydrate；不改原 collectRecords、学习目录排序或旧模式。直属 whole-source 记录不枚举其他行，正文只读目标页及其实际块子树；链接和学习祖先仍按原范围规则读取必要元数据。

调用方提供来源／目录 ordinal 与中央 deny，学习规则由已有适配器负责。普通单页便捷端口提交一个 upsert；需要联合课程根、祖先、目录或其他依赖时，学习适配器应使用同一 prepare 接口生成完整 delta，不能在此默认重新遍历全课程或让多个 ticket 共用一个 operationId。

图片 callback 必须返回已验证的独立 ImageAsset 与 StoredMedia，保持 `/media/v2/<assetId>`、owner、尺寸和摘要一致；没有下载、上传或 Notion 原图回退的默认实现。复用或新增资产由图片模块决定。内容准备复用完整 worker 的遍历保护，允许原来支持的显式 partial 表达，拒绝丢图、越过深度／块数等损失。

页面元数据在正文准备前后读取两次，可观察到的编辑、父级变化、归档／删除状态变化会停止该版本。本检查不是 Notion 的全局事务快照；深层页、来源 schema、漏事件和权限变化仍需独立发现／补查。普通原已发布页的[确认归档／移出撤回](WEBSITE_INCREMENTAL_WITHDRAWAL.md)已有单独核查；null 或资格未知不编码为 deleted，课程／学习仍走领域依赖。

比较未变化内容时，readPublished 必须提供同发布版本、配置、schema、readerVerified 的单页投影。对象键顺序和媒体查询顺序不改变比较结果；版本变化或媒体未就绪不会构造 delta。不存在 prior record 时仍由最终服务器 CAS 及范围校验决定是否接收新增。

## 验证与下一项

当前验证使用虚构 Notion workspace、私有临时 SQLite、显式假端口及 PGlite 中的实际冻结迁移／持久发布／增量 SQL／受限 reader。实际 helper 的联调用三页本地基线，只准备目标页，受限 writer 提交、独立 reader 角色核验实际内容、证据及版本，另外两页与总数保留；第二次同页信号识别 unchanged、不再提交。不是线上数据库或真实 TLS 验收。

其他场景覆盖目标正文读数、事件到单页转换及提交链路、无变化不提交、读回失败、结果丢失恢复、超时后无迟发、版本／范围漂移和媒体等待。没有调用真实 Notion、对象存储或云 SQL。

[持久目录与元数据发现](WEBSITE_INCREMENTAL_DISCOVERY.md)现已提供独立端口。后续由运行器接实际角色连接、图片实现和学习依赖，集中做指定真实页的变化与撤回验收。确认旧完整任务和新入口的切换方案后再替换冻结 release／Dagu，保留现有成功后小图接续和回滚路径；不为了导出、验收或每次同步重复全量采集。
