# PostgreSQL 大表索引变更

本说明用于后续索引候选的审查和安装准备，不授权真实数据库查询、建索引、删索引或恢复任务。项目请求及 DDL 必须纳入一次明确批准的目标、窗口、预算、重试与停止条件；纯本机方案准备不访问项目。

## 已冻结的 scoped 迁移

[`20261017122812_scoped_content_reads.sql`](../supabase/migrations/20261017122812_scoped_content_reads.sql) 在事务内创建 `nb_v2.records` 的 `records_read_href`。普通建索引会阻塞该表写入，因此原[安装步骤](SCOPED_CONTENT_READS.md)要求先排空内容 writer，在有限锁等待和语句期限的维护窗口执行。

这份迁移及[协议摘要](../database/scoped-read-protocol.json)保持原字节；已安装且摘要一致时不重跑。不能直接插入 `CONCURRENTLY`：它不能在事务块中运行，也会破坏既有迁移身份。未安装且无法提供原维护窗口的环境，应先准备单独的安装路径与能力握手方案，再请求批准，不能临场拆改冻结 SQL。[PostgreSQL 建索引说明](https://www.postgresql.org/docs/17/sql-createindex.html#SQL-CREATEINDEX-CONCURRENTLY)

## 后续新增索引

持续写入的大表，优先把 `CREATE INDEX CONCURRENTLY` 作为独立的非事务执行阶段；空库或已排空的小表可按已审窗口采用普通事务建索引。不要把并发 DDL 放进 `BEGIN`、函数、迁移工具的自动事务包装或 `psql --single-transaction` 中。安装器不支持独立阶段时先停下，不能自动退回阻塞写入的普通建索引。

每个候选固定目标 schema／表、索引名、列或表达式顺序、谓词、排序、唯一性和所用方法，明确旧索引与约束依赖、采用方和回退方式。真实目录检查应在获准预算内执行。仅有同名索引或 `IF NOT EXISTS` 成功不能证明定义正确；不把检查结果直接当作未经审查的新期望值。

使用专门的所有者连接，保留 TLS 与最小权限。锁等待、语句期限和总窗口须有明确上限；非事务阶段使用该专用会话的设置，不依赖仅在事务内有效的 `SET LOCAL`。关闭连接结束临时设置，不改全局数据库参数，也不通过终止其他业务会话强行获得锁。

并发创建仍有额外扫描、资源负载及等待，同一表同时只能有一个并发创建。分区表、唯一索引和约束接续需要专门方案，不能照套普通非唯一索引步骤；应按实际数据库版本复核限制。并发不是“无锁、无成本或必定在窗口内完成”的保证。[并发构建限制](https://www.postgresql.org/docs/17/sql-createindex.html#SQL-CREATEINDEX-CONCURRENTLY)

## 完成、失败与回退

创建返回后，在同一授权窗口核对精确对象与完整定义，检查 `pg_index.indisvalid`、`indisready` 和 `indislive` 均为真。适用时验证原读取路径与新路径；仅有索引状态不证明实际性能改善，也不授权自动启用应用开关。完成后才登记对应安装回执或能力状态。[索引目录字段](https://www.postgresql.org/docs/17/catalog-pg-index.html)

失败、超时或连接结果不明时停止，不自动重发，也不假定事务已把索引删除。并发创建可能留下无效索引；在获准范围内核对目录状态，并保留原错误与观察结果。重建或移除必须按明确的后续处置执行，不能用 `IF NOT EXISTS` 把残留对象误报为成功。

若已审回退需要删除本项索引，先确认其身份、定义和依赖。适用的 `DROP INDEX CONCURRENTLY` 同样不能包在事务中，只处理一个索引，不支持 `CASCADE`；约束支持索引和分区索引不能直接套用这一方式。不能删除原有有效索引、连带删除约束，或把应用回退自动扩大为数据库清理。[删除限制](https://www.postgresql.org/docs/17/sql-dropindex.html)

本机静态核对或隔离引擎检查不能证明真实服务器的并发锁行为、等待时长或负载。没有真实获准演练时，记录必须明确保留这些未验证项。
