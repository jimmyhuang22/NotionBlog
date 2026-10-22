# 搜索候选的同语句资格复用

`filtered-scope` 是默认关闭的服务端候选，接续[过滤搜索](SEARCH_FILTERED.md)的原文预筛选。原 `on-demand`、`filtered`、`precomputed` 保持可选，未设置 `DATABASE_SEARCH_PROJECTION` 时仍为 `on-demand`。本项只准备代码和草稿 PR，未安装 SQL、启用配置、合并或部署。

## 条件与权限

候选扫描仍对每条记录调用原 `nb_v2.record_eligible`。只有通过预筛选的集合含至少一篇学习笔记时，才交给私有 `nb_read.search_scope_known`，为整组候选复用本语句已证明的资格；混合集合中的课程与 Status 也在复用范围内。未命中的笔记不会触发优化，纯平坦集合继续原 helper。

helper 的 known 集合仅由受信任扫描产生的记录构造；API 参数只有 publication mode、栏目和受限 probes。引用与媒体仍从同一 run 的真实表定位：集合外目标继续 `record_eligible`，撤回、祖先、epoch 和来源规则不变。没有跨请求资格缓存。

新增函数均为 `STABLE SECURITY DEFINER`，固定 `search_path=pg_catalog` 并限定表／函数 schema。创建与撤回默认授权在同一事务中完成。API 与摘要检查只授予 `nb_reader` 及其派生角色；内部 helper 不授予 reader、writer、PUBLIC、anon、authenticated 或 service_role。安装所有者仍必须有受信任的现有角色与 schema 所有权，迁移不会创建新的业务凭据。

## 独立迁移与能力检查

[独立 manifest](../database/search-filtered-scope-protocol.json) 绑定新增迁移、`notionblog-search-filtered-scope-v1` 和 SHA-256。它只依赖三份基础 scoped 读取迁移及原有 publication 基础，不要求旧 filtered 或 precomputed 扩展。历史文件与摘要不改。

经另行授权安装时，所有者须先核对 manifest 和迁移实际字节、角色／函数权限及原目录不变，再将受检 SHA 登记到 `nb_read.migrations` 的 `version=5`；未登记或错误摘要会使新搜索关闭。不要为安装候选复制现有资格、延长期限或运行写入任务。本项没有执行任何安装步骤。

未来单独批准启用时，网站需为 `DATABASE_CONTENT_VERSION=2`、`DATABASE_READ_PROJECTION=scoped`、`DATABASE_SEARCH_PROJECTION=filtered-scope`；本候选不写入环境值。回退可在另行批准后恢复原搜索模式，新迁移不修改内容表或原三条读取函数；新模式启用不等于 SQL 安装成功。

只有搜索读取使用 `check_search_filtered_scope`，与基础检查合为一次往返；其 pending／失败 promise 独立于普通读取，可失败后重试。缺失或慢扩展不会持有课程、首页或目录的能力检查，也不回退 mock。错误按 `CONTENT_UNAVAILABLE` 处理。

## 保留的边界与验证

- 复用原受限 Unicode 预筛选；不支持的查询以空 probes 调用原完整 search-parts 路径。SQL 扫描最多 20,000 条候选前记录，投影最多 32 MiB，原深度边界保持；超限失败，不截断结果。
- TypeScript 继续在已清理的片段上执行精确匹配、排序与全量分页，保留 16 MiB 应用投影限制和最后一次版本复核。媒体单独变化即使不增加 revision，也不能沿用旧结果游标。
- PGlite 测试使用虚构课程、深层笔记、Status、链接和媒体，比较完整 DTO／顺序／游标；在含笔记分支检查资格调用减少、无笔记分支不变，同时覆盖撤回、候选外目标、权限、版本竞态和失败隔离。

本机测试不证明托管环境性能或真实 PostgreSQL 17 的多会话可见性，仍需后续独立验收；没有重开任何真实请求窗口。已有性能数字只属于原各自证据，不能作为新模式上线收益。当前验证结果见[本项进度](progress/2026-10-23-search-filtered-scope.md)。
