# 2026-10-13：增量执行器与单页内容准备（Codex）

编辑登记：沿用本项 `codex/website-incremental-queue`，普通带入最新 develop；新增 executor／publication-port／source 及相关测试、说明。repository 只追加 collectRecord 单页方法，完整 worker 只导出原遍历保护供复用；没有重写学习排序、发布 SQL、完整收集或媒体交付。

执行器先恢复未知提交，再按任务数／时间上限处理页级准备、显式提交和独立 reader 验证。零延迟也不会同轮反复重试；取消或丢失响应后保持待核对，未知操作存在时停止新发布。单页方法复用现有 AST、物理来源和祖先校验，不枚举其他来源行；媒体只接受独立验证的 descriptor，正常未变化记录不构造 delta，变更期间源元数据变化或媒体等待则延后。

与主重构新增 helper 采用端口，不复制其 SQL；新增 helper 合入 develop 后普通带入该版本，并提供明确 SqlExecutor 绑定。内容便捷端口只生成一个 upsert，学习依赖由领域适配器生成完整 delta。来源删除／授权异常不根据 null 响应猜测；发现、真实撤回、独立媒体和运行器仍未接入。

验证：首次与持久发布基础整合的 check1346／privacy571、build40 trace 通过；增量 SQL helper 随后新合入，实际 helper 联调和 check1356／privacy579、build40 trace 通过。学习及增量 reader 也在本轮合入 develop，已普通带入，无代码冲突；源方法与其新增学习适配器均保留。最终组合针对性 40 项（15 queue、14 executor、10 source、1 实际 SQL 联调）通过：单页更新保持另两页与总数，独立 reader 核验内容／证据／版本，下一次未变化不提交；finalize 失败不 ack，恢复只补确认和检查点。最终集中 npm run check 的 1380 项、隐私检查 590 文件及 npm run build 的 40 server trace 均通过。

开发中媒体路径曾误用另一入口，已按冻结 v2 的 `/media/v2/` 修正；联合类型已拆分。联调测试最初误用 getDetail 方法名，已按实际 get 契约修正，生产代码未为测试改接口。因为新增代码及上游实际接口／学习组合改变才再次验证，不对正常同步反复执行测试。

全部来源数据为虚构 fixture；实际 SQL helper 与独立 reader 已在本地 PGlite 联通，图片端口为假实现。没有真实来源请求、云 SQL、下载、编码、上传、发布、迁移、部署或排程操作。下一项接来源发现、实际角色连接和资产／学习适配器，再执行指定页变更的真实回读与切换验收。
