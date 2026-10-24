# 撤回媒体查询索引与历史范围

后端复核 B08 的性能修复候选是 [`public-cache-media-owner.sql`](../database/indexes/public-cache-media-owner.sql)：给 `nb_v2.media` 新增非唯一 B-tree `(owner_page_id, asset_id)`。它支持原有跨批次 owner 查询及资源去重，不改变公开资格、计划格式、缓存标签、角色权限或冻结迁移摘要。

## 为什么保留历史范围

撤回计划记录当前子树的全部历史媒体关系。这是[既有下架语义](PUBLIC_CONTENT_CACHE.md#立即下架)，不是误加的历史批次：其他公开页可能还引用目标以前的 owner URL，必须继续识别并要求独立绑定。仅加 `run_id=current_run` 会遗漏这种共享引用。

实际清缓存使用 content／home／media 的宽标签，覆盖旧 URL 和四档图片；不是按 `assets` 数组逐个删除对象。缩短数组不会让清理范围随之变小，也不能据此宣称消除了“过度清除”。相同物理字节、不同 owner 地址仍可保留，不删除存储对象。

原查询已经 `DISTINCT asset_id`，因此超过四万条历史行不一定越界；超过四万个**不同资源**才触发资源数量保护，另有两万页面和 8 MiB 计划限制。本轮保持这些限制。失败时不会新增 deny 或清理事件，也不能报告已下架；需要容量扩展时，须另行设计有界计划／恢复协议，不能截断列表、去掉保护或仅看当前批次后继续执行。

索引以 owner 为首列，匹配没有 run 条件的查询；`(run_id, owner_page_id)` 不适合作为这条跨批次查询的首选。第二列覆盖要返回及去重的资源 ID。索引仍占空间并增加写入维护成本，不保证大子树查询永远使用索引。[PostgreSQL 多列索引说明](https://www.postgresql.org/docs/17/indexes-multicolumn.html)

## 独立安装阶段

这是需单独审阅、授权和记录的可选性能索引，不是新协议迁移。文件刻意放在 `database/indexes/`，不接入构建、应用启动、冻结缓存安装器或 `supabase db push`。缺少索引时原功能仍按既有逻辑运行；本轮未安装到真实数据库。

实际执行遵守[索引变更规则](POSTGRES_INDEX_CHANGES.md)：先明确目标、有限窗口、流量预算、一次尝试及失败停止条件，再核对表定义、非分区状态、已有索引、空间与依赖。专用 owner 连接启用 TLS 校验，设置有限的会话 `lock_timeout`／`statement_timeout`；不要将本文件包进事务或自动迁移批次。该文件只有一条 `CREATE INDEX CONCURRENTLY`，不隐式启用缓存或调整业务排程。

目标是 `nb_v2.media_withdraw_owner_asset`，精确期望为非唯一 B-tree `(owner_page_id, asset_id)`，默认升序／空值最后、默认操作符类和列排序规则，无表达式、谓词或 INCLUDE 列。安装前如发现同名对象先停止核对，不用 `IF NOT EXISTS` 掩盖残留或错误定义。安装后核对完整定义以及 `indisvalid`／`indisready`／`indislive`，再在授权预算内验证原查询与固定计划一致；不只凭命令成功认定改善。

超时或结果不明时保留回执并停止，不自动重试或改成普通建索引。同名无效对象的处理需另行明确；批准回退后，只能删除核实为本项创建且无新增依赖的这一索引，使用独立的 `DROP INDEX CONCURRENTLY`，不带 CASCADE。保留原主键、业务数据、deny、缓存事件及冻结协议。并发 DDL 仍可能等待、扫描和增加负载。[PostgreSQL 并发建索引说明](https://www.postgresql.org/docs/17/sql-createindex.html#SQL-CREATEINDEX-CONCURRENTLY)

## 离线证据与边界

本机 PGlite 执行实际候选 DDL；在 45,000 条无关媒体与两个目标历史资源的虚构分布下，未经强制的原资源查询从顺序扫描改为使用新增索引，完整撤回计划前后一致。测试同时覆盖旧 URL 被其他公开页引用、跨批次重复去重、40,000／40,001 个资源边界、失败零写入及 reader／publisher 无越权。

这证明本机查询可使用索引和语义不变，不是生产耗时、云端流量、真实服务器并发锁行为或所有数据分布的性能承诺。B08 的索引缺失已提供修复候选；“历史都是过度清除”的结论已纠正；超大撤回的容量扩展仍待独立方案。
