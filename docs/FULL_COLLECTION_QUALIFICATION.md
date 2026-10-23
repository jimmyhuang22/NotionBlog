# 完整新采集的服务端资格绑定候选

本项提供完整新采集资格入口及默认关闭的私有host接线源码。它补齐“普通新租约不返回服务器有效期”的证据，不安装数据库能力，不授予reader／writer新权限，也不把源码候选当作运行许可。共享入口源码范围已获[明确确认](decisions/2026-10-23-full-collection-host-wiring.md)。

`scripts/website-sync/full-collection.ts` 提供 `qualifyFullCollectionLease` 和 `runFullCollection`。只支持qualified模式下的stage／publish，所有页面由普通collector重新采集；旧capture、resume参数、先前批次比较和incremental baseline输入均拒绝。媒体仍执行原字节及owner验证，不因本入口放宽缓存或公开范围。

## 来源与写入顺序

1. 调用者提供当次已审的配置摘要、revision、epoch、当前成功批次、freshness及完整采集／后置所需的最短剩余时间。配置与预期在异步前复制，不从旧回执推断当前许可。
2. 原受限writer创建新租约。只在其返回后，用单独owner executor执行一次显式字段的只读SELECT，核对state／run身份、schema、策略、空staging、新租约及服务器期限；不读取记录正文、来源表、凭据或历史DTO，不获取行锁。
3. 将独立的 `full-collection` 资格回执交给 `onQualified` 持久保存。保存失败或资格不足时由本入口清理本次拥有的新租约；清理失败显式报告，不重试，也不开始来源采集。原成功指针保持。
4. 资格成功后才开放Notion／媒体读取和stage；本地单调时钟保守扣除读取往返，超过服务器期限停止。每次writer操作仍由原SQL执行租约、策略和撤回检查；本地回执不能缓存公开资格或代替数据库授权。
5. 原collector仍负责完整性、最终来源复核、stage及promote。promote调用后不增加可能将已提交发布误报为未发布的本地期限断言；原异常和未知结果流程保留，不能据退出码恢复旧指针。stage模式照旧失败收尾其新租约。

SELECT在一个语句中观察提交快照；时间使用数据库的 `clock_timestamp()`，而非客户端墙钟或事务开始时间。语义依据见[PostgreSQL单语句快照](https://www.postgresql.org/docs/17/transaction-iso.html#XACT-READ-COMMITTED)和[服务器当前时间](https://www.postgresql.org/docs/17/functions-datetime.html#FUNCTIONS-DATETIME-CURRENT)。此观察不锁定未来状态，后续权限仍由SQL检查。

## owner连接与运行接线

owner连接由未来运行负责人通过父进程API显式提供；源码不加载owner凭据，没有默认owner连接工厂。普通reader／writer没有基础表权限，不能传给此入口，也不能将维护cache适配器加白名单来替代owner。实际端口必须事先验证身份和严格TLS，使用独占连接、服务器语句超时不超过10秒，并支持abort与销毁连接；晚返回的端口也会关闭。源码没有新增角色、GRANT、RPC、SQL迁移或安装器，也不预设mapped接口存在。

`run-private.mjs` 可选 `fullCollection` 参数块必须含 `format: website-full-collection-plan-v1`、`expectation` 与 `postSeconds`；expectation严格包含配置摘要、revision、epoch、当前成功、freshness与minimumRemainingSeconds。最短剩余时间须覆盖本次content timeout及postSeconds。所有resume键与此块互斥，只接受qualified的stage／publish；省略此块沿用原流程。`--check` 只校验本机输入，不创建owner连接、子进程、锁或预算。普通命令行不提供owner工厂，新模式执行会拒绝；工程调用者须显式传入父进程 `ownerMetadata` 端口，不能用环境变量偷偷接通。

父子进程使用Node IPC固定消息，绑定父进程创建的新run与随机nonce；子进程没有owner凭据或通用SQL端口。父进程只执行固定元数据SELECT，最多一次、10秒、4KiB响应；查询前持久记录独立owner预算，失败／未知结果不退款、不重试。关闭owner连接后才交付元数据，子进程仍执行原资格检查。超时并不证明远端已结束，连接销毁失败会使host失败并要求人工核对。

`run.ts` 在显式新模式调用 `runFullCollection`。独立qualification与binding同时保存在原私有receipt及单独文件中，绑定新run、原始来源SHA、release commit、manifest／runtime SHA与服务器期限；不添加resume标签。`full-collection-control.ts` 提供纯prepare／binding／四阶段post校验，拒绝旧run、来源／release／预算输入漂移、过期、缺失或重复后置，以及混入fresh-resume证明。JSON只提供审计证据，不授予运行权限。

控制器prepare、publication-binding、content driver与body admission／最终join仅在私人离线副本中适配。缺省仍走原fresh-resume分支；完整新采集需独立新预算及显式父进程launcher。content后置完成后保持等待body，同批thumbnail／snapshot／visitor／body全部通过，且连接和自有锁结清、无未决写入，最终join才返回可持久化的完成提案。保留原维护限额、游戏日期／课程树消费者修复、正文分组和补充回执处理；没有替换已安装文件或修改DAG。私人副本不是可执行安装包。

owner资格读取是以后真实执行的一部分，需要其当次范围和预算，不能重用先前一次metadata导出许可。旧成功、controller、排程、媒体贡献、失败账本、原完整新采集预算及其他任务状态均不由本源码候选改变。

## 验证与后续执行边界

验证使用虚构来源、受限角色的本机PGlite和真实父子进程IPC；冻结host夹具覆盖原fresh-resume和缺省入口。服务器期限先按数据库时间与单调时钟约束采集，控制器审计仍受原绝对停止窗口约束；本机结果不证明实际owner／TLS或云端已验。

本轮仅源码、离线副本及草稿PR：不新增迁移或权限，不读取真实凭据／来源／数据库，不创建可执行的真实配置，不安装、同步、合并或部署。最终release／runtime／来源schema、实际owner端口、空lease／未决写入、新预算、停止窗口及软件回退仍由原运行负责人固定。活跃自然周期不作为移交窗口。这里的预算数字是源码上限，不是已授予的真实窗口。
