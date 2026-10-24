# B10：缓存刷新提交屏障方案（源码与隔离测试已批准）

用户于 2026-10-24 明确同意按本方案实施源码与隔离测试，包含临时原生测试引擎准备。候选已实现为默认关闭的独立扩展；真实数据库、权限、凭据、运行包与任务状态未修改。批准范围见[决定](decisions/2026-10-24-cache-commit-barrier.md)。

## 结论与目标

现有缓存行触发器在首次投影写入时调用 `enqueue_refresh`，该函数先对 `nb_cache.state` 单行 `FOR UPDATE`，再查重、递增 generation 和插入事件。同一事务后续重复命中同一事件，也不会提前释放这把锁。社交／媒体事务尚在继续工作时，另一完整发布就可能在缓存锁处等待。

单改为语句级触发器能减少调用次数，但仍在首条业务语句处取得相同锁，并持有到事务结束；不能作为 B10 的完整修复。行锁的生命周期见 [PostgreSQL 锁说明](https://www.postgresql.org/docs/17/explicit-locking.html#LOCKING-ROWS)。

建议保留现有全局 generation 和 v1 事件／签名／reader 协议，将自动事件的全局屏障推迟到事务的延迟约束触发器阶段。目标是业务写入阶段不再持有这把全局锁，提交阶段仍以它保证代次、事件及业务数据原子可见。不是无锁方案，也不保证所有提交永不等待；其他锁、延迟约束和提交耗时仍需测量。

## 已实现的源码范围

1. 追加独立扩展与摘要，不改写已冻结的 `20261020203508_public_content_cache.sql` 及其摘要。新增私有 `commit_config` 和 `commit_intents`；安装后新模式默认关闭，只有明确激活才切换。公开 schema、角色成员和 reader／writer 权限不扩大。
2. 自动 content／social／media 触发器保留原身份、范围、启用检查、事件 ID／版本计算。新模式开启时只在同一事务插入意图，以原事件 ID 去重；不同事务不写同一意图主键。模式明确关闭时走原路径，配置缺失／异常则停止，不能猜测模式。
3. 私有意图表配置 `AFTER INSERT DEFERRABLE INITIALLY DEFERRED` 约束触发器。在延迟阶段调用原 `enqueue_refresh`，仍由原全局锁查重、分配 generation、写入原事件；成功后删除本事务意图。失败使整个业务事务回滚，不能吞错或把业务提交改成无事件成功。已经登记的意图即使在同事务里关闭新模式，也必须执行完。
4. 同事务多行、多语句的同 scope 仍只有原先的一个事件；混合 social／media 保留各自事件。事务回滚和 savepoint 回滚必须同时撤销相应意图，不能留下仅有事件或仅有数据的状态。
5. 显式 `enqueue_refresh` 以及立即撤回继续同步执行。现有成功 ACK 后的显式 hook 必须是独立短事务，不能放回长业务事务；下架、完整来源资格、原队列／签名／ACK／重试语义及待处理历史事件保持。生产者必须在 COMMIT 成功后确认成功，不能仅凭前一条写语句返回就确认。
6. 安装者必须与原缓存对象 owner 一致；新对象采用私有 schema、RLS、直接访问撤权、固定 search_path 和精确 definer／EXECUTE 边界。清除新对象从任何全局默认 ACL 继承的非 owner 权限，再只授予 operator 读取能力状态；新表不会授权普通 worker、reader、anon 或 authenticated 直接写入。更新目录审阅与安装工具的明确前后像，不绕过旧摘要守卫，也不让构建自动安装。

延迟触发器及 `SET CONSTRAINTS` 的行为见 [CREATE TRIGGER](https://www.postgresql.org/docs/17/sql-createtrigger.html) 和 [SET CONSTRAINTS](https://www.postgresql.org/docs/17/sql-set-constraints.html)。调用方可以显式强制提前执行；这会重新提前取得缓存锁，性能目标因此只适用于保持延迟的生产者。当前源码检索未发现业务 `SET CONSTRAINTS`，但真实冻结运行包仍须独立核对。延迟屏障也未必是所有延迟约束中的最后一项，不作零等待或固定提交时长承诺。

## 不采用简单序列代替提交版本

不能把 sequence 的当前值或 `MAX(event.generation)` 直接当作新缓存 stamp。A 先取得 1 后等待，B 取得 2 并先提交；若客户端已缓存 stamp=2 下的结果，A 随后提交时 MAX 仍为 2，其数据变化不会使缓存键改变。直接读 sequence 当前值还可能在业务提交前提前生成新键。分配序号不是提交顺序；[序列说明](https://www.postgresql.org/docs/17/functions-sequence.html)也明确 sequence 推进不随事务回滚。本方案保留事务性的 generation 屏障。

## 已完成的离线论证与局限

实施前先在忽略目录建立无项目身份的 PGlite 机制实验，当时尚未实现实际 `nb_cache` 扩展。8 项 SQL 检查通过：多行去重、显式事务内不提前推进、整轮回滚、保留 savepoint 前工作、撤销首个意图、延迟阶段失败整轮回滚、混合 scope 两事件、强制提前执行仍可原子回滚；另一个纯逻辑模型复现 MAX(sequence) 的乱序遗漏。它们验证 PostgreSQL 延迟机制及反例，不证明候选实际权限、并发性能或生产正确性。

初始本机只有客户端工具。批准后从[官方 PostgreSQL 17.11 源码](https://ftp.postgresql.org/pub/source/v17.11/)核验发布 SHA，编译到忽略目录，创建只监听私有 Unix socket 的临时实例，测试结束关闭并删除临时数据目录；没有系统服务或 TCP 监听。

原生最终 14 项通过，实际运行原 `social_sync.ingest`、受限角色及 `nb_v2_api.promote_run`：默认关闭可复现旧阻塞，开启后未提交社交不阻止完整发布，较晚的社交提交继续推进版本；反向提交、回滚、提交阶段超时回滚、同 scope 逆序、强制提前执行、原签名 purge／ACK／scope 合并、读取栅栏和同步撤回均覆盖。只证明隔离候选行为，不是生产性能基准。

新的目录模块只导出有界只读系统目录 SELECT、固定前像摘要／后像比对及 legacy／installed／mismatch 分类，不连接任何环境。期望从已审候选的虚构安装固定，并由原生实例再次吻合；实际安装时不能用现场结果自动生成期望。PGlite 的 NOT NULL 约束项与 PostgreSQL 17 的表示不同，因此约束列表排除重复的 n 类型，但非空列属性仍逐项严格验证。函数正文／owner／definer／search_path、包含未知角色的完整 ACL、列、其他约束和延迟触发器保持固定。

## 源码验收与复现

- 使用原实际缓存迁移、真实生产者触发器与受限角色的隔离数据库验证：默认关闭／开启、重复事件、混合 scope、回滚／savepoint／延迟失败、权限和不变的 v1 DTO。
- 准备仅本机使用的临时原生 PostgreSQL 测试引擎，不增加项目依赖、不注册系统服务、不接项目凭据。先复现旧方案中 A 在业务阶段持锁导致 B 超时，再证明新模式下 A 尚未提交时 B 可完成、A 最后提交仍使新 stamp 可见；补相反提交顺序、回滚、同 scope 并发、撤回、显式 enqueue 和约束强制提前执行。本次已取得原生隔离多会话证据；它不替代实际运行图与现场安装验收。
- 验证原消费者的 scope 合并、100 条窗口、签名清理、精确 ACK、并发新事件及未知结果处理；缓存读取前后版本栅栏必须继续拒绝跨代结果。更新受检摘要与测试辅助信息，不扩大历史冻结兼容白名单。
- 完成对应 `npm run check`、离线 build、隐私、目录／协议及差异核对后，按 develop 规则合并。应用层 DTO、栏目开关、来源范围及前端不变。

源码文件由临时官方 Supabase CLI `migration new` 生成：`supabase/migrations/20261024121910_cache_commit_barrier.sql`；独立摘要与已审目录在 `database/public-cache-commit-protocol.json`，旧缓存迁移摘要保持原样。新模式需 owner 在安装／核对／排空后显式更改私有 `commit_config.enabled`，operator 只能读取能力状态，不能直接激活或写意图。不可把普通 `supabase db push` 当作只读验证。

本机原生复现只接受已准备的绝对本机工具目录，不接受数据库 URL，也不读取 env 文件：

```sh
node tests/native/cache-commit-concurrency.ts --bin /absolute/private/postgres/bin
```

该命令自建并清理临时库，不在日常测试中启动服务；CI 的普通完整检查执行 PGlite 和协议测试。原生验收作为本项独立必要检查执行，不用跳过结果冒充通过。安装工具如需回读项目，仍须按下节授权；不能直接运行此实验去接生产。

## 实际安装与回退另行授权

后续的[真实安装、启用与回退准备](BACKEND_CACHE_COMMIT_ROLLOUT.md)列出实际运行图、事务边界、维护目录接续、未知提交和授权工件；该方案未授予项目操作许可，完整执行入口仍须先补齐。

真实环境须先核对、停止并排空相关来源／社交／媒体生产者、缓存消费者及维护，保留失败／未知提交与历史事件。安装前审阅实际 PostgreSQL 版本、目录前后像、角色、运行图、触发器和维护 catalog 守卫；安装会改变函数定义，旧维护摘要应当拒绝，不能无条件重绑。

获准后才安装默认关闭的独立扩展，核对权限和旧路径，再在已排空的受控窗口激活。安装／激活需有界 lock_timeout／statement_timeout；遇到仍在途或同名不匹配对象就停止，不重装旧建库 SQL。回退同样先停并排空，确认没有本项在途提交后切回旧自动路径；不清除原事件、deny、失败回执或重新采集。

真实目录回读、SQL 安装、模式激活、凭据与云配置、项目流量、任务恢复及正式发布均不包含在本次源码实施确认内，须准备具体范围和预算后另行授权。B03 等其他安装前置条件也不被本方案解除。
