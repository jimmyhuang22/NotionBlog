# 搜索资格复用与结果读取保护

`DATABASE_SEARCH_PROJECTION=filtered-scope` 使用独立的版本五只读能力，在单条搜索 SQL 内复用已验证记录的资格。缺省仍为 `on-demand`；代码合入不启用生产模式，不触发安装、同步或部署。

## 读取与权限

先执行现有快照、物理父链和中央撤回检查，再做不丢失必要候选的预筛。只有本条语句已经确认的记录可复用资格，其他链接与媒体 owner 继续走原检查，缺失媒体不会恢复。没有学习笔记候选时沿用原投影；无法构造完整必要条件时读取原片段。匹配、排序、完整分页、游标与末尾版本复核仍由同一 repository 完成，不提前截取首屏，也不在请求间缓存资格。

[协议](../database/search-filtered-scope-protocol.json)引用既有规范迁移 [filtered_search_scope_reuse.sql](../supabase/migrations/20261022214425_filtered_search_scope_reuse.sql)，字节保持原样。需要 scoped／search-parts／iterative-walk 及版本五能力，旧 filtered／precomputed 扩展不是前置。缺函数、空摘要或错误摘要明确报错，不回退 mock；搜索能力失败与普通页面能力分开。

公开读取函数沿用专用 reader 的受限 `SECURITY DEFINER` 入口，私有 helper 为 `SECURITY INVOKER`；固定 `search_path=pg_catalog`，PUBLIC、writer 及其他平台角色不取得新入口权限。helper 使用 STABLE 的同语句快照，不能接受 reader 伪造的已授权集合。语义参见 [PostgreSQL STABLE](https://www.postgresql.org/docs/17/xfunc-volatility.html) 与 [Supabase 函数权限](https://supabase.com/docs/guides/database/functions)。

## 可选结果保护

`DATABASE_SEARCH_RESULT_BUDGET` 缺失、空或 `off` 保持原路径；`bounded-v1` 仅支持 database v2、scoped、qualified、搜索上下文 off，以及 on-demand／filtered-scope。未知或不兼容组合返回现有配置错误。来源行功能可以独立配合资格复用，但不能为开启此保护而擅自关闭来源行；若来源行已启用，先保持保护 off，待相应组合另行验证。

保护仅在搜索 HTTP 请求内创建，累计最多 13 MiB SQL `result::text`、四条受检结果语句。连接获取前预留次数；在同一语句中只计算一次原结果及尺寸，超限仅返回尺寸并报现有 503，不截断结果。SQL NULL、JSON null、布尔值和参数含义保持，内部尺寸字段不会进入 DTO。超限、取消或查询失败阻止继续提交；保留当前全局 SQL 次数／响应限制、剩余期限与连接释放行为。

结果文本限制不是 PG 协议、TLS、连接认证、CPU 或账单上限，原结果仍需在数据库中计算。该保护默认关闭；正式应用不包含 S13 专用 HMAC、接收字节插桩或验收请求入口。

## 启用与回退

正式启用时先按既有安装记录确认当前 reader 已具备规范能力；已有安装不重复运行迁移或覆盖登记。单独批准生产模式配置，随已审阅的新版本部署生效；不得直接提升历史测试部署。普通离线开发与 CI 强制使用 on-demand、保护 off 和演示数据。

发布前确认配置组合、可用旧生产部署及其原环境。回退优先指回保留的兼容旧部署；改为 on-demand／保护 off 需创建使用这些选项的新部署，不能假设修改项目设置会重建运行中的 repository。无需回填内容或卸载版本五函数；卸载、权限修改与同步恢复均不属于代码发布。

## 证据与限制

[S13 记录](progress/2026-10-26-s13-live-readiness.md)对同一插桩候选做了十八次真实对照，TTFB 中位数降低 68.4%、该组 PG 接收降低 97.7%，响应一致。测试只有三个固定词，其中两个无匹配，配置来自共同历史输入；正式集成去掉专用插桩并保留 develop 后续保护，所以不能把该百分比直接写成现站收益。正式启用后的有限抽查仍需验证响应、延迟与实际效果。本次集成验证见[进度记录](progress/2026-10-26-search-production-integration.md)。
