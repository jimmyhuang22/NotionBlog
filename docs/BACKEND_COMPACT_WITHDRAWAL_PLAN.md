# B08 紧凑撤回计划方案

状态：基于 develop `7ada24a9f358e738468a96f46e3d4e9607cca811` 的静态复核，用户已明确批准“同意紧凑方案源码与隔离验证”，见[决定](decisions/2026-10-25-compact-withdrawal.md)，实施及验证编写中。本方案采用显式 opt-in 的 v2 计划，将单次不同资源容量从旧版 40,000 扩至 400,000；保留完整历史共享检查、原子撤回和原恢复阶段，不新增分批账本。

## 1. 已核实的问题与目的

原 B08 关于“历史都是过度清除，应只查 current_run”的建议已被交接作者撤回。目标以前的 owner URL 仍可能被其他当前公开页使用，必须继续查全部历史。缺索引已提供[可选 owner 索引](PUBLIC_CACHE_WITHDRAWAL_INDEX.md)，真实安装独立管理。

现有 [v1 SQL](../supabase/migrations/20261020203508_public_content_cache.sql)与[客户端](../scripts/public-cache/withdraw.ts)显式限制 20,000 页面、40,000 不同资源、8 MiB 计划；越界在 deny／事件写入前失败，不能报告已下架。这是尚未解决的大规模撤回能力限制，不是已证实的误删。

资源数组用于完整共享检查、执行前精确比较、数量统计与首个资源的四档抽查；实际 deny 只收 target，缓存按 content／home／media 宽标签清理，也不删除 COS 对象。因此存在更小的扩容方法：保存完整集合的数量／强摘要／一个样本，数据库继续完整检查。无需为了缩小 journal 就新增持久批次表、分页 ACK 或清理生命周期。

## 2. 新计划契约与容量

保留旧 plan／journal version 1、旧 assets 数组、旧 40,000 上限和原命令行为。新增独立 version 2 plan／journal，保留 target、runId、revision、epoch、pages、sharedOwnerUrl、leaseActive 及站点／Origin／连接摘要绑定，将 assets 数组替换为：

```ts
assetSummary: {
  algorithm: "nb-withdraw-assets-sha256-v1";
  count: number;             // 0..400000，不同资源数
  digest: string;            // 64 位小写十六进制
  sample: string | null;    // C 次序首项；count=0 时为 null
}
```

v2 严格校验字段、类型、计数／样本对应关系和算法身份；不接受旧 assets 与新 summary 混合，未知版本／算法拒绝。sample 仅用于抽查，不授予共享检查或清理范围。完整 JSON 仍不超过 8 MiB，页面仍不超过 20,000。

400,000 是本次明确提出的新硬边界，不是无限容量承诺。第 400,001 个不同资源立即拒绝，不能取前 400,000 项后假装集合完整。重复历史行可能远多于唯一资源数；索引、排序、去重和共享检查仍可能在既有预算内失败，不能保证上限以内的任意数据分布都完成。

## 3. 完整集合摘要与共享检查

在单条调用语句的 STABLE 快照中取得当前目标子树及其**全部历史** owner→asset 集合。DISTINCT 与排序均显式使用 C collation。以查询行循环读取至多 400,001 个唯一值，不构造全部资源 JSON、数组或无限 string_agg。

每个资源必须精确符合 `a1.` 加 64 位小写十六进制，共 67 个 ASCII 字节；底表没有这项 CHECK，发现坏值须整案拒绝，不能用 WHERE 正则悄悄滤掉。数量、摘要和首项样本来自同一完整序列，规范固定如下：

1. 初态为 PostgreSQL 内建 SHA-256 对 UTF-8 字节 `notionblog:withdraw-assets:v2:start` 的原始 32 字节结果。
2. 每项更新为 `SHA256(0x01 || 原始32字节前态 || 67字节assetId)`；不对十六进制字符串继续 hash。
3. 终态为 `SHA256(0x02 || 原始32字节末态 || 8字节大端有符号整数count)`，最后才输出小写 hex；计数使用 pg_catalog.int8send 的字节规则，离线以独立 Node 编码器验证固定向量。

这个 SHA-256 链是完整有序集合的抗碰撞承诺，不是来源授权凭据。排序／去重在数据库内部仍可能使用工作内存或临时文件，不能把 32 字节累积态误写成整个 SQL 的恒定内存或扫描量证明。[内建 SHA-256](https://www.postgresql.org/docs/17/functions-binarystring.html)、[STABLE 快照](https://www.postgresql.org/docs/17/xfunc-volatility.html)

共享 URL 检查直接关联目标子树的**全历史 media**与当前合资格外部页面的 `$.**.src`。保留原 `split_part(src,'?',1)` 处理和相同 owner URL 的拒绝语义；不得使用 sample、摘要或当前批次媒体替代这个关联。它继续覆盖原 src 守卫，不声称新增了任意 href／编码地址扫描能力。

## 4. SQL、事务与恢复

新增独立 SQL 扩展／manifest，函数拟为 `nb_cache_api.plan_withdraw_compact(text)` 与 `nb_cache_api.withdraw_compact(uuid,jsonb)`。不替换旧函数，不改历史迁移、旧 manifest、事件接口、缓存标签或存储删除策略；复用现有 nb_cache.events JSONB payload 和 read_withdraw／read_event。

新写入口显式 VOLATILE，先核 v2 版本／大小／结构，以原顺序取得 nb_cache.state 与 nb_v2.state 锁；任何非空 lease_run 都拒绝，包括过期／残留租约，不能按状态或到期时间自行视为空闲。取锁后以一条独立内部查询调用 STABLE planner，让完整页面、资源摘要和共享检查使用该查询开始时的同一快照；取锁本身不会刷新已经建立的快照。精确比较完整 v2 JSON，变化或共享 URL 即拒绝。current_run／revision 本身不足以证明历史集合未变，不能只比较版本号或 sample。

通过后，在同一事务写 target deny、递增 generation 和保存原 scope=withdraw 事件。事件 UUID 冲突、不同 payload 或不同版本拒绝。原五个 journal 阶段保持：先保存未知写入意图，结果不明只读回同事件；已提交恢复用原 payload 和 deny 证明，不对已经 deny 的目标重新规划或盲目重发。宽标签 purge、代表页面和样本四档 HTTP 核验仍沿原次序。清缓存未确认时保留 deny 及待清理事件；已 ACK 后抽查失败时，数据库事件可能已 complete，仍保留 deny 和 PURGED_VERIFY_PENDING 本机 journal，不能宣称操作 COMPLETE。

原六个本机业务锁、原角色／严格 TLS 与 15 秒 statement／20 秒 client query 预算保持，不新增全局 LOCK TABLE 或延长等待。源码中的受限同步、发布及历史删除入口均先锁 nb_v2.state；新方案沿用这一协调纪律。超级用户／对象 owner 的任意直写不受该纪律自动保护，实际采用前必须核对全部真实 actor 与维护窗口，不能把六个本机锁说成数据库全局互斥证明。

## 5. 显式采用与安装边界

新规划命令拟为 `withdraw-cli.ts --compact <page URL> --plan <absolute .local journal>`。缺省仍为 v1。execute／resume 只按已严格验证的 journal 版本选固定 SQL 路径，不接受调用者传函数名；缺新扩展或能力不匹配明确失败，不回退到截断列表或旧计划。旧 v1 journal 的读取、执行和恢复继续验证。

新增受控显式安装器，沿用[固定 owner 会话](../scripts/website-sync/owner-install-session.ts)模式，为本扩展新增独立固定 recipe 与 purpose 绑定的 factory 准入；N08 原会话仍只允许原两份已审正文，新旧用途不能互相装载脚本，也不接收裸 SqlExecutor／Pool 或任意 DDL。预检、DDL、独立扩展摘要及最终 ACL 校验在同一固定连接／事务完成；只为既有 nb_cache_operator 授予这两个新入口执行权，撤销 PUBLIC，保持 reader／publisher／anon／authenticated 不可执行，不改 LOGIN 成员、既有角色属性或原表直接权限。部分／同名未知安装拒绝，不自动补权。仅准备源码安装入口，不从 worker、构建、部署或本轮实际运行调用。

独立 manifest 固定两函数的签名、源码摘要、owner／search_path／volatility 和 ACL；安装后及新入口准入按这些固定期望读取目录核对，不从现场学习允许值。不新增业务表、摘要状态表或原表字段。COMMIT 未知与清理失败沿用明确结果分类，保留首错，不自动重试安装。

迁移文件通过本机官方 CLI 的 `migration new` 生成，再按独立摘要审阅；不会执行 login／link／db push／pull 或项目命令。如现有本机缓存没有可用 CLI，批准范围包含在本项忽略目录准备官方生成工具（公开发布源，校验发布摘要，下载总量上限 128 MiB、一次失败停止）；不增加项目依赖，不改系统路径或注册服务。原生数据库验证复用已有引擎。

新函数未必改变 B10 只列固定旧函数的 catalog 结果，但会进入覆盖整个缓存 schema 的 rollout facts。独立核验新扩展及旧固定 catalog，并重新准备、审阅相关安装 facts；旧回执保留原事实，不能自动沿用为新安装许可或放宽旧 digest 比较。

## 6. 离线验收与交付

开发期只做必要定向验证，源码稳定且独立审阅后集中一次完整 check／build。范围为局部虚构数据和本项新临时数据库：

- 40,001 个资源的新 v2 路径成功；旧 v1 仍在相同条件失败。400,000／400,001 边界，失败零 deny／event；页面、JSON 与未知版本保护保持。
- 空集合、乱序／重复历史、同计数换资源、非法 ID、sample 非首项或被篡改、独立 Node／SQL 摘要向量；全历史旧 owner URL 即使不在 sample 中也阻断。
- 计划后历史／当前资格变化、租约／版本变化拒绝；原子 rollback、事件冲突、提交结果未知、清缓存／抽查失败后的恢复与旧 journal 兼容。
- 权限／固定安装连接／部分安装／摘要与 ACL 不符拒绝；旧迁移、manifest、B10 固定 catalog、事件／缓存守卫保持，广范围 facts 变化被识别为需新准备。
- 复用既有原生 PostgreSQL 引擎，仅本项新 Unix socket 临时集群验证真实 MVCC：规划期间固定快照、缓存锁等待后重算能看见刚提交的历史、原 nb_v2.state NOWAIT 冲突拒绝、受限 writer／retention 的 state 锁排斥，以及 statement 预算失败零业务写入。完成后清理本项进程和目录；不使用真实运行根或凭据，不新增引擎／系统服务。

不是性能达标或真实目标可采用证明。提交前按常规做隐私、记录、链接、实际差异及发布暂停核对，英文 PR、base develop、普通合并；包含正常 PR／push 自动 CI，不手动派发。只有最终确实完成的检查才记通过。

## 7. 本次明确不包含

真实项目／Notion／数据库／Storage／网站／图片请求、真实目录／凭据／云配置、索引或扩展实际安装、真实数据重写／回填、运行包采用、清缓存、业务任务恢复、main 合并、部署或域名操作。不得复用其他工作线已关闭的授权窗口。

[AGENTS.md](../AGENTS.md) 要求共享范围“先得到用户确认，再实现与合并”。本方案新增 v2 journal／SQL 契约和显式全局命令入口，已取得用户对源码、离线验收和本机生成工具准备范围的一次明确批准，不构成真实安装或执行许可。
