# 增量准备的终态与领域退役

学习与其他领域会先保存下一份私有检查点，再由[公共执行器](WEBSITE_INCREMENTAL_EXECUTOR.md)记录提交标记并发送。如果准备失败或服务器明确拒绝，本机准备状态需要释放；如果提交结果未知，仍需保留恢复数据。本模块提供持久队列证明和幂等退役回调，不替代领域 store 或主运行器。

## 终态证明

队列 v3 增加私有 retirements 表。v1／v2 的升级在同一事务中完成，保留既有目录、事件、提交状态，并为既有已关闭的准备登记待处理退役。不会为待核对或已发布成功的操作生成退役证明。

`queue.attemptClosure(operationId)` 返回 `AttemptClosure | null`：

- `disposition=never_submitted`：准备被持久关闭、放弃或未提交完成；`payloadDigest=null`。过期本身不足以证明；claim 事务须先关闭旧 preparing 并撤销其提交资格。此后旧 ticket 不能重新 markSubmitting。
- `disposition=definitively_rejected`：匹配的明确拒绝已由 confirmRejected 持久登记，payloadDigest 保留原提交摘要。

当前准备、未知提交、lookup 无结果、过期但仍未关闭的准备及已提交成功均返回 null。公开接口无法用任意超时或租约失效生成退役证明。普通 unchanged 也产生 never_submitted，领域没有对应准备时可以幂等 no-op。

`pendingRetirements(limit)` 最多返回 50 个待处理终态；`acknowledgeRetirement(proof)` 重新核对来源、页、代次、操作身份、处置和摘要，成功后才标已处理。证明仍可私有查询，身份历史不自动删除。

## 执行器接线

`IncrementalPorts.retire?(proof, signal)` 先接到领域 store，随后公共执行器确认退役。所有参与该操作的领域都完成后，回调才应返回；任何领域失败保持待处理，下轮只补退役，不先开始新准备。回调本身必须幂等，不能以已经清理为错误拒绝重复确认。

运行顺序是：恢复未知提交及独立 reader／finalize → 处理待退役终态 → 新 claim／prepare。`claim(..., {requireRetirement:true})` 在事务中回收过期准备并检查待退役状态，有未完成退役则不生成新 ticket。退役计入每轮动作上限，预算用尽留下一轮，不在同轮无限重试。

明确拒绝先写队列终态，再调用 retire；成功提交仍走 verify／finalize／ack，不退役已应用状态。准备取消后先写未提交终态，取消的信号不启动清理，下一轮恢复。回调成功但回复丢失、或本机确认失败，重启会再次调用同一终态回调，不重新采集或发布旧操作。

未提供 retire 的旧内容端口保留兼容，但不会自动清理领域准备；只要 prepare 会保存领域状态，正式运行器就必须配置此回调，不能忽略 retirement_pending。Dashboard 状态计数新增 retirement_pending，不含页面身份或正文。

## 领域与运行器责任

prepare 返回前取消时，队列尚未取得完整准备载荷，所以 never_submitted 的摘要为空。领域须按 operationId 读取自己已持久的摘要，再核对当前队列终态并退役对应准备。明确拒绝则必须匹配 proof.payloadDigest。不能把未提交的空摘要补造成已知提交，也不能退役已应用的检查点。

领域在所有异步返回后及持久 stage 前检查 AbortSignal；可以紧接同步写入前调用 `queue.assertPreparing(ticket)`，阻止已关闭 ticket 继续准备。此检查不提供跨两个 SQLite 文件的事务，正式运行器仍须持有 canonical 互斥并停止／等待取消后的实际传输，不能让旧 actor 在退役后补写。仅凭 timeout 清理不满足该约定。

主运行器负责混合栏目版本接续、领域路由和实际取消；学习端负责自己的 stage／install／retirePrepared，图片端负责资产状态。本次只增加公共生命周期接口，没有安装 CLI／排程或访问真实内容。
