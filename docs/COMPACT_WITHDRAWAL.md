# 紧凑撤回计划 v2

这是 [B08 方案](BACKEND_COMPACT_WITHDRAWAL_PLAN.md)的显式 opt-in 后继入口。它支持最多 400,000 个不同资源、20,000 页面和 8 MiB 计划；实际是否能完成仍受查询预算和数据分布影响。旧 v1、40,000 边界和旧 journal 保持；没有自动切换、安装或真实下架。

## 计划与命令

在另行完成扩展安装、角色／原锁／站点核对及整轮实际操作授权后，才能对真实目标调用。以下仅展示参数形式，域名和路径都是占位：

```sh
node --env-file=/absolute/.local/operator.env scripts/public-cache/withdraw-cli.ts --compact https://example.invalid/study/course --plan /absolute/.local/withdraw/plan.json
node --env-file=/absolute/.local/operator.env scripts/public-cache/withdraw-cli.ts --execute /absolute/.local/withdraw/plan.json
node --env-file=/absolute/.local/operator.env scripts/public-cache/withdraw-cli.ts --resume /absolute/.local/withdraw/plan.json
```

不加 `--compact` 的规划仍走 v1。execute／resume 只按本机 journal 的已验证版本选固定 SQL；未知、混合或缺能力均拒绝，没有降级回旧数组的路径。

v2 计划只返回完整历史不同资源集合的数量、固定算法 SHA-256 链和排序首项样本，不返回几十万个资源 ID。样本仅供四档地址抽查；数据库共享检查仍关联完整历史媒体与当前合资格外部页面。其他公开页引用目标的旧 owner URL 时仍拒绝，不能改为只查当前批次或样本。

## 执行和恢复

沿用原六个业务锁和数据库两行锁的顺序。任何非空 lease_run，包括过期／残留，都拒绝；缓存锁等待后通过新的内部查询完整重算并精确比较计划。版本号、资源数或样本相同都不足以替代完整摘要与共享检查。

通过后原子写 deny、generation 和事件；清缓存仍用宽标签，不逐对象删除 COS 文件。提交结果未知先读同一事件证明，不重新规划被 deny 的目标或盲目重发。清缓存未确认时保留 deny／待清理事件；已确认清缓存但抽查失败时，事件可能已 complete，本机 PURGED_VERIFY_PENDING journal 仍保留。只有全部完成才报告 COMPLETE。

撤回计划比较独立于通用缓存键：两版本都按完整字段、对象键序无关／数组次序保留的规范化 JSON 比较，上限 8 MiB、12 层和 250,000 节点。原恢复错误复用了 16 KiB 缓存键保护，合法大计划可能在已提交后卡住；本项仅修撤回比较，不放宽网站通用缓存键。原私有 journal 文件读取仍为 10 MiB，以承载计划和绑定信息。

## 能力和安装

独立 [manifest](../database/compact-withdrawal-protocol.json)绑定新 SQL、固定执行配方及两个旧冻结来源。能力准入在同一个目录查询快照核对两新函数和五个直接依赖的源码、签名、返回类型、owner、语言、volatility、search_path 与权限；不授予 operator 读取私有 schema 的新权限。旧资格／deny／回执函数变化时也拒绝，不能仅看新函数是否存在。

[安装器](../scripts/public-cache/compact-withdrawal-install.ts)只接受本用途的受控会话。新旧 owner 用途不能互装脚本，拒绝 Pool／裸查询对象和任意 DDL；严格 TLS、新固定 Client、单事务、事务身份复核、固定 search_path、首错及提交结果分类保持。完整相同安装可复核，部分或未知同名状态拒绝；业务 CLI、构建和部署不调用安装器。

这份 SQL 位于独立 manifest 指定的迁移文件中；不要把 `supabase db push` 当作只读检查或本扩展的受控采用方式。实际安装必须另审完整前后像、权限、依赖和停止条件，不沿用旧安装授权。只新增函数不必然改变 B10 的固定函数 catalog，但会改变覆盖整个 schema 的 rollout facts，相关准备须重核。

400,001 个不同资源、过大页面／计划、未知算法、坏资源 ID、共享 owner 地址、租约、版本或完整摘要变化均停止，不截断、不删除历史证明、不放宽超时。数量限制不是物理扫描行数保证；同 UID 的任意文件写入、对象 owner／超级用户绕开协调的直接 DML／DDL 也不由这套源代码自动防护。

本项验证范围和失败历史见[实施记录](progress/2026-10-25-withdrawal-capacity-review.md)。真实目标安装、网站清理效果、TLS 握手、运行包采用、业务恢复及发布仍分别验收。
