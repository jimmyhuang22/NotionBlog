# 可选搜索资格复用

`DATABASE_SEARCH_PROJECTION=filtered-scope` 是独立、默认关闭的候选模式，要求 `DATABASE_READ_PROJECTION=scoped`。未设置时仍为 `on-demand`；原 `filtered`、`precomputed` 的入口和能力检查保持。代码可用不代表数据库已安装、生产已启用或性能验收完成。

## 读取行为

新入口先按当前公开模式获取快照，逐条检查当前记录的物理父链与中央 deny，保留原必要条件预筛和正文片段顺序。若候选包含 `study-note`，引用投影从这些已通过筛选的记录中建立仅本条语句有效的 ID 集合。已知候选可复用本条语句的资格结果，其他链接／owner 继续调用原资格函数；媒体表仍实时参与投影，缺失资产不能因 owner 已知而恢复。

父调用和 helper 使用 `STABLE`，复用范围符合 [PostgreSQL 的同查询快照规则](https://www.postgresql.org/docs/17/xfunc-volatility.html)。内部 helper 为 `SECURITY INVOKER`，公开读取函数因 reader 没有底表访问权而沿用受限 `SECURITY DEFINER` 接口；两者固定 `search_path=pg_catalog`。身份通过专用数据库角色与现有公开政策决定，不使用 Supabase Auth 用户会话。权限原则参考 [Supabase 函数说明](https://supabase.com/docs/guides/database/functions)。

没有学习笔记候选时使用原 `search_scope`，无法构造完整必要条件时使用原片段读取。每个新请求都重新筛选；未知目标、祖先撤回、媒体删除及新旧批次仍由原规则处理。TS 保留完整匹配、排序、分页和结果指纹，末尾再次读版本。没有提前限制为首屏。

## 能力与安装边界

[独立协议](../database/search-filtered-scope-protocol.json)固定由 Supabase CLI 生成的[新迁移](../supabase/migrations/20261022214425_filtered_search_scope_reuse.sql)及其 SHA。它只增加：

- `nb_read.migrations` 的版本五记录，初始摘要为空；
- 私有 `nb_read.search_scope_reused`；
- 只读 `nb_read_api.read_search_filtered_scope` 与 `check_search_filtered_scope`。

前置为原 scoped／search-parts／iterative-walk 三项能力；旧 filtered 或预计算扩展不是本新迁移的前置。新模式在一次冷搜索检查中合并验证这三项及版本五摘要，不增加兼容检查往返。摘要为空、错误或函数缺失时明确报错；待决／失败的搜索检查与普通读取分离，不阻塞课程等路径，不回退到 mock。

此候选没有执行真实安装。后续获准后，应由安装负责人核对当前输入、数据库版本、受检迁移 SHA、角色成员和结构保护前后像，再单独应用新文件、将其 SHA 登记到版本五并用真实受限 reader 验收。不得用改写旧摘要、重新安装整套迁移或修改原清理保护来绕过不匹配。新表、写入任务、保留政策、源配置和前端 DTO 均不在本项范围。Supabase 云端 advisors 尚未运行；安装阶段应检查当前环境的实际安全／性能提示。

内部 helper 没有 reader 的 schema／执行权限，读取与能力函数只授予 `nb_reader`；PUBLIC、writer、anon、authenticated、service_role 的执行权限显式撤销。不能以伪造候选数组直接调用 helper。

## 验证与回退

本机 PGlite 覆盖独立能力缺失／空或错摘要、环境选择与显式禁用、可选检查隔离、四路径完整分页与 Unicode／回退、两种公开模式、祖先／外部链接／媒体撤回、revision 不变时的媒体游标失效、末尾版本竞争、过期／epoch、角色与 helper 权限、无匹配情况下的两万条上限，以及仅在学习笔记候选中减少资格计算。

旧 reader 兼容测试只更新“当前新字节仍须拒绝”的断言，冻结转换与历史摘要不改。没有将局部调用减少写成正式冷启动、p95、数据库执行计划或回传节省；新模式仍返回完整候选正文。

后续实际启用须另行确认环境配置。回退先将应用选项恢复到启用前值，原三条路径和 SQL 函数仍在，无需重装或数据回填。若另外决定卸载，只撤销／移除本次新增的两个公开函数、私有 helper 和版本五登记；不使用 `CASCADE`，不删除业务记录，也不改版本一至四或预计算状态。已缓存的能力成功不替代函数存在性：卸载后新模式仍会明确报错，因此配置回退应先完成。
