# 完整新采集的服务端资格绑定候选

本项提供独立工程入口，不接入既有CLI、主机或排程。它补齐“普通新租约不返回服务器有效期”的源码部分，不安装数据库能力，不授予reader／writer新权限，也不把源码候选当作运行许可。

`scripts/website-sync/full-collection.ts` 提供 `qualifyFullCollectionLease` 和 `runFullCollection`。只支持qualified模式下的stage／publish，所有页面由普通collector重新采集；旧capture、resume参数、先前批次比较和incremental baseline输入均拒绝。媒体仍执行原字节及owner验证，不因本入口放宽缓存或公开范围。

## 来源与写入顺序

1. 调用者提供当次已审的配置摘要、revision、epoch、当前成功批次、freshness及完整采集／后置所需的最短剩余时间。配置与预期在异步前复制，不从旧回执推断当前许可。
2. 原受限writer创建新租约。只在其返回后，用单独owner executor执行一次显式字段的只读SELECT，核对state／run身份、schema、策略、空staging、新租约及服务器期限；不读取记录正文、来源表、凭据或历史DTO，不获取行锁。
3. 将独立的 `full-collection` 资格回执交给 `onQualified` 持久保存。保存失败或资格不足时由本入口清理本次拥有的新租约；清理失败显式报告，不重试，也不开始来源采集。原成功指针保持。
4. 资格成功后才开放Notion／媒体读取和stage；本地单调时钟保守扣除读取往返，超过服务器期限停止。每次writer操作仍由原SQL执行租约、策略和撤回检查；本地回执不能缓存公开资格或代替数据库授权。
5. 原collector仍负责完整性、最终来源复核、stage及promote。promote调用后不增加可能将已提交发布误报为未发布的本地期限断言；原异常和未知结果流程保留，不能据退出码恢复旧指针。stage模式照旧失败收尾其新租约。

SELECT在一个语句中观察提交快照；时间使用数据库的 `clock_timestamp()`，而非客户端墙钟或事务开始时间。语义依据见[PostgreSQL单语句快照](https://www.postgresql.org/docs/17/transaction-iso.html#XACT-READ-COMMITTED)和[服务器当前时间](https://www.postgresql.org/docs/17/functions-datetime.html#FUNCTIONS-DATETIME-CURRENT)。此观察不锁定未来状态，后续权限仍由SQL检查。

## owner连接与运行接线

owner executor由未来运行负责人显式提供；本模块不创建连接、不读取环境或凭据。普通reader／writer没有基础表权限，不能传给此入口，也不能将维护cache适配器加白名单来替代owner。实际连接必须有原本已有的必要读取权限、正确TLS及身份，并使用独立固定的请求／字节／期限预算。源码没有新增角色、GRANT、RPC、SQL迁移或安装器，也不预设mapped接口存在。

现有host配置及receipt schema未修改，旧publication-binding仍拒绝缺少fresh-resume证明的输入，不能假补标签。后续应审阅完整新采集prepare、host调用本入口、独立owner元数据读取端口与同批后置绑定的具体接线；采用新的显式参数时须按共享入口范围确认。最终release／runtime／来源schema、空lease／未决写入、新预算、停止窗口及软件回退仍由原运行负责人固定。活跃自然周期不作为移交窗口。

owner资格读取是以后真实执行的一部分，需要其当次范围和预算，不能重用先前一次metadata导出许可。旧成功、controller、排程、媒体贡献、失败账本、原完整新采集预算及其他任务状态均不由本源码候选改变。

## 下一步待确认的接线方案

- `run-private.mjs` 增加默认缺省的fullCollection参数块；与所有resume输入互斥，check模式仍不启动连接、子进程或预算。既有模式保持原行为。
- 新增固定的本机owner读取旁路，父进程持有连接，采集子进程不取得owner数据库凭据。只允许本次新run的固定元数据语句，最多一次、10秒、4KiB返回；只读、无通用SQL、无自动重试，计入新独立预算。这里的数字是候选上限，不是已授予的真实窗口。
- `run.ts` 在显式新模式调用本桥，将独立full-collection回执写进原私有receipt；不假补resume标签，不把旧capture、旧run资格或工作站时间当作新许可。
- 控制器准备和同批后置增加对应的默认关闭候选分支，绑定新run、配置及release／来源摘要和服务器期限；保留原有fresh-resume、限额适配及验收修复。只在离线副本编写、验证，不替换已安装文件或修改排程。
- 这一步仍仅源码及草稿PR：不新增迁移或权限，不读取真实凭据／来源／数据库，不创建可执行的真实配置，不安装、运行同步、合并或部署。真实角色选择、预算、停止／回退和owner移交继续另审。
