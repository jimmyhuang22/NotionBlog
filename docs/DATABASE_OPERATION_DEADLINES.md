# 数据库读取与独立运维期限（M08）

源码与离线交付见[进度](progress/2026-11-02-m08-reader-deadlines.md)。真实网站、运行包及现役导出脚本需分别采用，合入 develop 不会改变它们。

## 网站与社交读取

网站数据库、社交、直连 Notion 的数据库策略查询、自托管启动检查及 reader 检查 CLI 使用 `readerSqlExecutor`。每个业务 SQL 在同一次 `pool.connect()` 取得的连接中执行：

1. `BEGIN READ ONLY`。
2. `SET LOCAL statement_timeout = <毫秒>`，取当前连接配置、15 秒上限及请求剩余时间的最小值。社交配置为 10 秒。
3. 原来的参数化业务 SQL。
4. `COMMIT` 后归还连接；业务失败则在剩余期限和预算内 `ROLLBACK`，无法确认回滚、连接已断或已取消时销毁本次连接。

不依赖事务池是否接受 startup GUC，不在 `pool.query` 上 SET 后另借连接。控制命令确认、SQL 结果及归还都在当前请求期限内；没有请求上下文的服务端渲染、媒体或启动检查也有独立 30 秒读取预算。原请求整体 30 秒预算、私有就绪 8 秒、池大小、checkout／query_timeout、TLS 和资格规则不扩大。不会修改共享 pool options。

每个业务语句正常增加三条控制 SQL，失败最多以 ROLLBACK 替代 COMMIT；这些控制语句及其行 JSON 也计入通用 SQL 预算。搜索 result-text 上限只计原业务结果，仍为原来的 4 条业务语句／13 MiB；不把 BEGIN 等送进其业务模板白名单。

私有就绪保留最多 8 条业务／权限／能力语句，并允许合计最多 32 条实际 SQL（含 24 条控制），两次探针合计至多 64 条；行 JSON 仍共用每次 256 KiB。维护调用方未来准备执行预算时须计入新增控制成本。协议、请求／响应 DTO、nonce 和样本范围未改。

原 `sqlExecutor` 继续供同步写入和非网站工具使用，不被强行包装为只读事务；冻结 SQL、运行协议、同步程序和现役 pin 不因本项修改。

## 归档导出与恢复

三个 operator CLI 的 export／restore 使用专用单连接池：

- `scripts/database.ts`：v1 归档；其他子命令保持旧配置。
- `scripts/website-database.ts`：v2 核心／混合归档。
- `scripts/publication-database.ts`：持久发布／增量／冻结归档。

| 设置 | export | restore |
| --- | --- | --- |
| 连接截止 | 20 秒 | 20 秒 |
| 服务端单语句 | 60 秒 | 120 秒 |
| 客户端单查询等待 | 65 秒 | 125 秒 |
| 整个 CLI 进程期限，含文件／媒体与清理 | 300 秒 | 1,800 秒 |
| 锁等待 | 5 秒 | 5 秒 |
| 池大小 | 1 | 1 |

TLS 和连接串验证仍复用原校验。已知 Supabase pooler 只接受 session 端口 5432；拒绝 transaction 端口，避免归档的 session advisory lock 或跨语句状态漂移。未知代理的池化模式不能从端口推断，运维者仍须保证专用 session。连接后显式设置并检查该 session 的语句超时；不 ALTER ROLE／DATABASE 或借用网站池。

CLI 期限由独立于 SQL 超时的 Node 计时器执行，正常完成时清除。到期退出码 2，只输出固定错误；恢复期限到达输出 `OWNER_ARCHIVE_DEADLINE_OUTCOME_UNKNOWN`，COMMIT 确认失败输出 `OWNER_ARCHIVE_OUTCOME_UNKNOWN`，不得自动重放。进程退出不证明远端事务已回滚或提交，仍须独立只读分类。计时器也不是对同步 CPU 阻塞的硬实时保证；现有归档大小／行数限制保持。

本机只验证期限机制和合成数据／原归档回归，不把 30 分钟当作已测得的生产恢复时间或恢复 SLO；真实规模恢复仍需获批后演练。v2／publication 的 `verify` 继续离线，不创建池或读取凭据。

## 原生 pg_dump 与现役包

日常 pg_dump 不由这三个 JSON CLI 执行。它的 300 秒／400 MB 有界导出已有冻结 G1 独立实现和演练；本项没有迁移、安装或改写现役 `round-db-export.sh`，也没有导出真实数据库。将来采用该有界方式时继续使用同锁、单次关闭记录和原出口预算，不能用压缩归档大小替代云端出口。

## 验证边界

`tests/native/m08-deadlines.ts` 仅连接命名固定的内部 Docker 夹具，使用虚构账号和夹具 CA；启动参数过滤模拟忽略 GUC，实际 PostgreSQL 17.11 执行 SET LOCAL、只读拒绝、pg_sleep 取消、回滚、并发及后端复用。它不是实际 Supavisor 实验，真实发布后仍需少量读取核对实际服务端设置，不需要重跑负载或全量下载。

资料：[PostgreSQL statement_timeout](https://www.postgresql.org/docs/17/runtime-config-client.html)、[node-postgres 事务](https://node-postgres.com/features/transactions)、[Supabase 超时](https://supabase.com/docs/guides/database/postgres/timeouts)。
