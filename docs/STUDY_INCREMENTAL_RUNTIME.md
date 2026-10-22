# 学习增量执行与可恢复检查点

学习[变化引擎](STUDY_INCREMENTAL_SYNC.md)的领域执行端。公开 DTO、网站入口、来源授权和现有 Dagu 不变。仅后台工程接入，不默认连接 Notion／云库、安装运行器或启动真实发布。

## 私有状态

`openStudyCheckpoint(privateDirectory, configDigest)` 创建独立 `study.sqlite`；目录须为真实路径、当前用户拥有的 700 目录，数据库及现有 journal／WAL／SHM 须为独占的 600 普通文件，拒绝符号链接与硬链接。SQLite 使用完整同步和短事务，来源配置摘要、schema 标识、JSON 摘要、完整学习图与大小均核对。

`initialize(checkpoint, proof)` 只接受同一完整私有发布生成代次的 `StudyCheckpoint` 和独立 reader 的基线证明；公开 DTO、历史单课或本机时间不能替代基线。初始化不可覆盖不同的既有状态。

`stage(operationId, studyDelta, preparedPublicationDelta)` 在发送前保存下一份检查点，并绑定预期发布版本、SQL payloadDigest、完整请求摘要和下一状态摘要。所有学习 upsert 与确认子树撤回必须和 SQL 载荷一致，不能出现数据库改了课程而本机仍保留旧图。已发布正文、数字覆盖、正文位置和目录 ordinal 保留，不逐事件导出远程全库正文。

`install({operationId, payloadDigest, publicationRevision, readerVerified:true})` 只在独立 reader 证明当前实际提交后，单事务安装检查点并登记已应用；重启重复安装同一当前回执可幂等完成。旧／错误版本、缺失操作、摘要冲突或已退役操作拒绝。成功安装后清除该操作的整份待安装正文，保留身份与摘要供 ack 丢失时恢复。不能把 writer 的 committed 当成独立证明。

活动准备最多 8 项、待安装正文合计 64 MiB、操作身份最多 10,000 条、SQLite 最多 32,768 页；超限明确失败，不自动截断或增大。`retirePrepared` 仅供公共队列在持久保存“未发送”或“明确拒绝”的终态证明之后，释放该准备快照；不退役已应用项。超时、过期 lease、null lookup 及未知回复不是终态证明，不能清掉恢复数据。初次切换遇到旧队列已有未知操作且没有对应学习准备状态，须由公共层恢复／核对，不能伪造 next 状态。

## 接公共执行器

`createStudyDomainPort(options)` 的 prepare、verify、finalize 与 retire 同公共执行器结构兼容。由公共运行器提供完整来源／媒体预算、canonical 互斥和实际 reader／writer 连接；本模块不读取默认凭据。示意接法：

```ts
const publication = createDatabasePublicationPort(writer, reader);
const study = createStudyDomainPort<QueueTicket>({
  store, sourceKeys: studySourceKeys, source, incomingLinks, assets,
  verify: publication.verify, assertPreparing: ticket => queue.assertPreparing(ticket),
});
await runIncrementalCycle(options, { ...publication, ...study });
```

上述队列必须仅包含学习来源。混合栏目队列的 prepare 路由在普通栏目得到 prepared delta 后，同样先调用 `store.stageOtherPublication(operationId, delta)`；其已确认提交通过同一 study verify／finalize 推进学习缓存的全站版本。可用 `ownsOperation` 路由恢复操作。非学习发布可更新已有学习 AST 入链，但不得改变学习 item／evidence、新增学习页或撤回学习节点；这些仍要经学习引擎。其他领域的缓存 finalize 也须全部成功后再 ack，各自保存按同一操作身份幂等恢复。

执行顺序是：领域准备 → 同步 assertPreparing 核对真实 queue 代次／lease → 持久 stage → 公共队列持久提交未知标记 → SQL 提交／lookup → 一次独立 reader 回读 → 所有领域 finalize → 队列确认。学习 verify 的当前回执证明在内存中绑定操作／摘要／版本，finalize 没有采集或 submit 路径。重启先由公共层 lookup、重新读回，再用已保存状态 finalize。取消会阻止后续页读取和迟到 stage；实际 SDK／媒体传输仍须由来源端口响应 AbortSignal。

公共执行器的 retire hook 只消费已持久的 AttemptClosure。never_submitted 的 null payloadDigest 表示尚未生成提交标记，由学习存储按操作身份退役本机准备；definitively_rejected 必须匹配提交摘要。未曾保存准备的操作可幂等结束，已应用操作拒绝退役；hook 成功后才由公共队列确认清理，恢复中不丢未知提交的数据。

## 显式依赖

- `source(state, signal)` 返回已有 worker 专用 `StudyChangeSource`；下一轮会重建资格会话。依赖页自身编辑版本变化／未知时会重新读取该页正文，不能把新元数据与旧正文拼在一起。来源未知、读取失败或媒体等待不能当作确认删除。永久删除仍需可信证据。
- `incomingLinks` 在 href／title 变化时，从同一发布版本的完整私有缓存产生非学习入链 upsert，返回版本、配置和已验证标记。它不是重新拉取所有远程正文的入口；缓存缺失／过时拒绝发布。
- `assets` 仅从已验证的独立资产准备／索引端口返回所有被本次 upsert 引用的 `StoredMedia` 描述，核对 owner、身份和尺寸。包含撤回旧祖先却重新纳入已搬走后代时需要带回的旧描述；无需重新读文件或上传未变原图。缺描述保持 pending，错描述转复核。

仍遵守公共 SQL 每数组 100 项和 16 MiB 上限，不盲拆跨课依赖。中央 deny 走政策更新与版本恢复，不伪装成来源删除。未经过本机 observer 的外部发布、配置变化或中央政策变化导致版本漂移时，停止并要求有界恢复／新基线，不仅改版本号掩盖缓存差异。

## 验证与运行边界

本机 SQLite／子进程验证准备落盘、错误证明不安装、正常退出前后恢复、SQL／私有子树一致、全站版本接续、终态退役和有限预算；领域测试覆盖 unchanged、来源／缓存漂移、非学习入链、缓存图描述、归档／deny、取消和超限。实际 PGlite writer、独立 reader 与重开的 SQLite 共同验证提交后丢响应、只 lookup／finalize 的恢复以及缓存媒体引用。

未安装云端扩展、初始化真实全课程检查点、接生产队列／资产索引、改来源／release／Dagu 或发布 main。真实验收仍需公共运行器与完整新基线就绪后的一轮代表变化；保持现有成功发布后的小图接续，不重复整库／全图读取。
