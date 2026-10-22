# 原子增量发布接口

这是 Notion 编辑 → Mac mini 变化队列 → 自有内容库方案的数据库提交端。变化队列、来源发现、学习依赖与媒体准备分别接入各自支线；本接口不自行读取 Notion、处理图片、确认未知删除或启动周期任务。

## 入口与责任

`src/server/database/incremental-publication.ts` 导出：

| 入口 | 使用者 | 行为 |
| --- | --- | --- |
| `readPublicationState(rawReader)` | 独立 reader | 取得服务器当前发布版本、政策 epoch 与配置／schema 摘要，不读取正文 |
| `preparePublicationDelta(input)` | 内容执行器 | 验证有限 upserts、已确认 withdrawals 与新媒体描述，复制输入并生成 payloadDigest |
| `createIncrementalPublisher(rawWriter).publish(operationId, prepared)` | 受限 writer | 在同一 SQL 事务中提交变化并切换持久发布，返回回执 |
| `.lookup(operationId, payloadDigest)` | 同一 writer | 恢复提交结果未知的操作；已提交返回原回执，无记录返回 null，摘要冲突明确拒绝 |

这里使用原始受限 `SqlExecutor`，不要传入只允许内容查询的 `publicationReader()` 包装。网站继续使用既有 repository、DTO、AST 和页面入口。

`PublicationDelta` 包含 `expectedRevision`、`configDigest`、`upserts: WebsiteRecord[]`、`media: StoredMedia[]` 与 `withdrawals`。版本是服务器产生的 `runId:revision`，不能用本机时间替代。撤回必须提供 `id`、原 `sourceKey` 和明确的 `archived`／`deleted`／`out-of-scope`；超时、权限未知和媒体 pending 不能转成确认删除。

每个数组最多 100 项，总正文载荷最多 16 MiB。upserts 必须有准备完成的正文；其 AST 的 complete／partial 仍如实保留。课程／父笔记在子页之前提交；跨课程移动应包括所有受影响后代与必要目录元数据。新图片先在独立存储准备并核验实际字节，再交描述；未变化资产自动从现有发布版复用，不传文件字节或 Notion URL。

## 提交与恢复

1. 读取当前服务器版本，完成变化页的来源、属性、正文、祖先、关系和媒体准备。
2. 调用 prepare；在本地队列持久记录 operationId、payloadDigest、expectedRevision 和“提交结果待核对”状态，之后才调用云提交。
3. 服务器按原政策／完整发布相同顺序锁状态，核对预期版本和配置。已有相同操作返回原回执；相同键、不同摘要或实际载荷拒绝。新操作将变化合入上一已发布版本，检查完整性后原子切换并保存回执。
4. 丢失响应或进程重启时先 lookup；不能直接重复采集或生成新操作冒充恢复。确认不存在、或版本已变化时，由队列按自己的恢复协议重新准备；不要仅改 expectedRevision 强行覆盖。
5. 回执 `committed: true` 只证明数据库事务完成。由独立 reader 核对当前发布版本和受影响内容后，队列才能确认完成；本接口不伪造 `readerVerified`，也不直接 ack。更晚发布已替换该版本时应重新判断任务代次和当前内容。

错误只暴露稳定码：`DELTA_VERSION_CHANGED`、`DELTA_POLICY_CHANGED`、`DELTA_DEPENDENCY_MISSING`、`DELTA_OPERATION_CONFLICT`、`DELTA_WITHDRAWAL_INVALID`、`DELTA_INPUT_INVALID`、`BUSY` 和 `DELTA_UNAVAILABLE`，不带 SQL、正文或真实来源编号。仅 PostgreSQL P0001 的已知拒绝可判为确定失败，scope／媒体／完整性拒绝归入输入错误；带同名文字的网络错误仍属于未知。未知提交失败先进入结果核对，而非无限自动重试。[独立 reader](INCREMENTAL_READER.md)提供按页比较和实际发布确认，不能用 writer 回执冒充确认。

## 保持的检查

中央 deny 会改变版本，过时任务拒绝；最新政策 epoch／摘要与当前范围仍强制执行。明确撤回课程或笔记时移除旧后代；显式移动到合法新父级的后代只有经新 upsert 校验才能重新纳入。移动父页但遗漏子页会失败，避免跨课程图不一致。已移除的图片引用也删除本版媒体资格，不能靠旧 assetId 继续读取。

复用冻结 v2／自动学习的 scope、父链、完整性和媒体引用检查，事务内任一步失败回滚新行、发布指针和操作回执。完整 publisher 正在持有 lease 时增量提交拒绝，继续使用同一业务互斥边界。内容和原图读取不调用 Notion。

增量提交只推进持久发布指针，不更新旧 qualified 的当前批次或有效期。新 delta 批次不具有整来源重新核验资格；旧模式过期后仍拒绝读取，不能靠复制已发布行续接四小时试验窗口。两种指针的最终状态在同一事务里切换，访客看不到中间状态。

## 安装与验证边界

在匹配的 v2 和持久发布扩展之后，迁移 owner 可用 `npm run website:sync -- migrate-incremental` 安装并登记独立扩展。安装不激活内容或改来源，也不能替代首次完整基线。新 schema 不暴露到匿名 API；reader 只查能力与发布状态，writer 可提交及查自己的操作回执，均无直接表权限。操作账本保存私有变化载荷，不能发给前端或写入 Git。

本阶段以 PostgreSQL 内部复制未改的已批准行来保持旧 reader 兼容，Mac mini 不发送未改正文或重取文件。它消除了来源全正文重读的提交要求，但数据库写入量尚非仅 O(变化页数)；后续可改为页面版本引用索引，当前不把源端增量与物理库零复制混为一谈。

PGlite 验证单页更新、旧媒体复用、未改正文、丢响应后恢复、操作冲突、过时任务、完整 lease 互斥、缺媒体原子回滚、课程依赖、子树撤回、移除图片、allowlist tombstone、政策／中央 deny 及宽泛角色默认授权。没有访问真实来源或云数据库。

真实切换前仍要完成来源发现／内容执行器、独立媒体、reader 回读、撤回时限、持久发布与操作账本的备份恢复，以及 Notion 断网验收；本接口合入 develop 不代表已安装到运行 release 或线上。参考 [整体方案](CONTENT_ARCHITECTURE_REASSESSMENT.md)与[发布基础](CONTENT_PUBLICATION.md)。SQL 事务和权限设计参考 [PostgreSQL 事务隔离](https://www.postgresql.org/docs/current/transaction-iso.html)及[Supabase 数据库函数](https://supabase.com/docs/guides/database/functions)。
