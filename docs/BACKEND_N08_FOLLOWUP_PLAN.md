# N08 页面提及与安装器收尾方案

状态：基于 develop `9c38bf62672cd206245c8a5ecd677aa7d2909830` 的源码审查，**用户已批准源码与离线测试，实施中**。本方案一次覆盖 N08 四项的源码与离线验证，并按常规流程向 develop 交付；不是实际数据库安装或发布方案。

## 已核实的问题

| 项目 | 当前情况 | 修复目的 |
| --- | --- | --- |
| 页面提及改名 | 转换器把页面标题写进 TextRun.text，之后改写器只更新 href；提及与作者普通链接转换后无法可靠区分 | 更新提及标题，同时保留作者自定义锚文本 |
| 集群角色重装 | reader-isolation 历史迁移无条件创建 nb_delta_reader；同集群其他数据库已存在同名角色时失败 | 在明确兼容规则下复用既有角色，不改全局身份或成员 |
| 安装连接与事务 | 两个安装器接收任意 SqlExecutor，迁移自行提交，摘要及复核在其后 | 保证所有安装步骤、摘要和验证属于同一固定连接、同一事务 |
| 内部发现注释 | 注释仍称已提交提示靠永久事件去重；实际已改为本地 checkpoint／revision | 准确说明恢复机制，不改变行为 |

## 1. 页面提及的最小契约

在 [TextRun](../contracts/content.ts) 增加可选 `pageMention?: true`：仅说明这段显示文字来自页面提及标题，不带 Notion ID、原始对象、私人名称或来源地址。

[转换器](../src/server/notion/blocks.ts)新增独立 opt-in，由 [v2 Notion provider](../src/server/notion/website-repository.ts)启用。仅 `mention.type=page` 设置标记；普通作者链接、用户提及、数据库提及和公式不借此改变。旧 v1 provider 不开启，旧 v1 校验器不放宽。

[v2 校验器](../src/server/database/website-validation.ts)允许字段缺省或严格 true，且必须配 internal／unavailable 链接；其他值或组合拒绝。新读取／验收端先接受该兼容字段，再采用会产生字段的同步端。现有公共 fixtures 无需批量改写，只补局部虚构回归。

[共享重写器](../src/server/notion/rewrite-study-links.ts)只为带标记的提及同时更新 text 与 href，保留样式；普通链接只更新目标，作者锚文本保持。撤回时保持固定中性文字及 unavailable 链接。标题块发生这类文字变化时，按 heading ID 同步已有 TOC 条目，保留其 ID、level、顺序，不新增目录条目。

publication JSONB、正文／学习缓存及 Status 文本保留字段并让现有摘要覆盖；v2 数据库投影保留它。无需 SQL 新列、迁移或冻结协议摘要变化，不改前端组件／视觉。搜索压缩投影不用于 AST 改写，不借本项改搜索 SQL。

**旧未标记 AST 无法准确倒推来源类型。** 不按旧标题或文字相等猜测清洗；旧记录继续兼容，修复历史显示需要未来另行获准重采。已下载副本不能召回。

## 2. 固定 owner 会话与原子安装

仅调整 [reader-isolation](../scripts/website-sync/incremental-reader-isolation.ts)和 [withdrawal-recovery](../scripts/website-sync/incremental-withdrawal-recovery.ts)两个显式安装器及其直接调用／测试适配，不扩展全仓库安装器。

新增受控 owner-session 工厂：生产实现内部创建并独占一个 `pg.Client`，沿既有严格 TLS／CA 配置执行，在一个 BEGIN／COMMIT 区间内完成前置验证、必要 DDL、摘要登记和末尾能力验证。不接收 Pool.query、裸 SqlExecutor 或任意调用方提供的查询函数作为固定会话证明。安装函数只接受工厂登记且仍在有效事务内的会话；普通接口改名或可伪造布尔标记不能通过准入。

离线 PGlite 适配仅在隔离测试入口使用其真实 transaction；不能把它冒充生产 Client。原生验证使用真实 pg.Client。更新必要的测试 helper／直接调用点，保持原通用 SqlExecutor 和普通网站连接策略不变。不新增自动安装 CLI，不在 worker 启动、构建或部署时连接数据库。

安装前验证全部源码／配方，事务设置有界语句／锁等待。摘要 UPDATE 和最终校验不得落在 COMMIT 之后。COMMIT 只在明确收到成功命令回执时报告完成；异常或未知提交不自动重试。ROLLBACK／关闭继续清理并保留首个失败，不能把清理失败写成安装成功。

完整已安装且摘要／权限匹配时可重复验证；历史部分安装、空摘要、摘要或能力不符不自动补写或扩权，拒绝并留待另审。两个扩展仍支持任意安装顺序。

## 3. 历史 SQL 与新安装配方

历史两份迁移及其现有 manifest 保持原字节和 SHA。新增独立、版本化的安装配方及其摘要，而不是修改旧迁移或把改写文本冒称原文本：

1. 先验证历史原文完整 SHA。
2. 仅按各自精确、唯一的已审边界取出外层 BEGIN／COMMIT 之间的事务体；reader-isolation 再取出那条精确 CREATE ROLE 语句，交由下述角色准入处理。
3. 校验所得执行体的独立 SHA，任何边界、语句次数或正文不符均拒绝。不做通用 SQL replace、模糊解析或任意迁移装载。
4. 在受控事务执行已审正文及验证，按原协议登记模式身份。新回执另列配方摘要与 installed／verified-existing 结果，不能将原模式摘要当成原始 SQL 文本已经逐字执行的证明。

不新增 SQL 表、字段、函数或迁移编号；新配方是这两个安装器的受审执行规则。原协议检查和历史迁移检查继续有效。

## 4. 集群角色的兼容规则

在上述同一事务中处理 nb_delta_reader：

- 不存在时创建原规定的 NOLOGIN、非 superuser、无 BYPASSRLS／CREATEDB／CREATEROLE／REPLICATION 的组。
- 已存在时先核对这些属性、该角色自身的父角色继承和目标库权限边界；仅完全兼容才复用。允许列表沿原 B03 的固定 schema／函数，包含已安装 thumbnail／withdrawal-recovery 的原例外；不把所有只读权限都视为兼容。目标库应用／私有对象的额外表或序列读取、未批准函数 EXECUTE、对象所有权，以及写入／DDL 能力均拒绝。系统内建和 PUBLIC 基础权限须与本组新增授权区分，不把额外私有权限静默纳入允许列表。危险属性或未知状态同样拒绝。
- 不 ALTER／DROP 既有角色，不重置其属性，不增删任何 LOGIN 成员，不替操作者“修好”冲突。创建竞争、锁等待或其他失败按有界失败处理，不隐藏重试。
- 当前数据库仅取得原隔离协议所规定的 schema／函数授权与撤销，不扩大公开范围。

角色是集群对象，复用意味着其既有成员可能取得新目标库同组权限；**这不是给生产／预发跨库成员授权**。任何实际目标采用仍须先核对真实成员、连接范围及目标库权限并另获整轮安装授权。本项也不改其他历史基础迁移的角色创建规则，不声称已解决整个仓库任意同集群重装。

## 5. 内部发现注释

只修改 [study-child-discovery](../scripts/website-incremental-sync/study-child-discovery.ts) 的过时注释：部分槽位已提交后，重放由已保存 fingerprint／revision 跳过，而非新增永久内部 event 去重记录。现有冲突恢复回归沿用，不为注释新增行为测试。

## 6. 验收与交付

开发期只跑必要定向验证；四项源码稳定并独立审阅后，集中一次完整 `npm run check` 与离线 `npm run build`，之后仅对实际新改动／失败／集成疑点补验。

- 提及：与作者普通链接区分、改名／撤回、样式、旧未标记兼容、标题与 TOC；实际 v2 生成、保存、发布、独立读取／重开链路保留标记；v1 不产生或接受新字段。
- 安装：真实固定 Client、拒绝裸查询／Pool／轮换查询对象；两扩展正反序与重复验证；DDL、摘要及最终验证失败均回滚；保留首错，提交未知不重发。
- 原生隔离数据库：复用本机已有 PostgreSQL 引擎，在本项临时新集群建立两个虚构数据库。基础角色先在集群建立一次，两个数据库具备同版隔离前基础，再顺序安装扩展，以验证同角色复用、既有成员不变及危险预置角色拒绝；包含额外私表／序列读取、函数 EXECUTE 和对象所有权的代表性负例，不仅测试 LOGIN／superuser 等属性。PGlite 不能代替这个跨数据库证明。
- 不新增项目依赖、不下载／安装原生工具、不注册系统服务；临时进程、数据库和目录只属于本项，完成后清理。需要本机 loopback 权限，但无项目出站。
- 提交前检查私有名单隐私、实际暂存、记录与链接；PR 使用英文、base develop，核对目标新变化、发布暂停及生成／实际受检差异后普通合并。正常 PR／push 自动 CI 包含，不手动派发或改写旧失败历史。

批准后同步需求、自己的决定／实施记录与审查状态。方案阶段只做文档格式、链接、差异和隐私检查，不提前运行应用全套。

## 7. 本次不包含

真实 Notion／数据库／Storage／网站／图片请求、凭据或云配置、实际角色／成员调整、历史数据回填／重采、私人运行包安装、业务任务控制／恢复、main 合并、部署或域名操作。现有持续任务与其他工作线的范围和账本独立保持，不复用旧关闭授权。

依据 [AGENTS.md](../AGENTS.md)：“依赖、契约、fixtures、栏目开关和全局入口等共享范围”须“先得到用户确认，再实现与合并”。本方案新增 TextRun 语义、owner 安装会话契约与角色复用规则，需对这份完整源码／离线范围一次确认。

参考：[PostgreSQL 集群角色](https://www.postgresql.org/docs/current/database-roles.html)、[node-postgres 事务与固定 Client](https://node-postgres.com/features/transactions)、[Supabase 数据库连接](https://supabase.com/docs/guides/database/connecting-to-postgres)。已核对公共更新索引；本方案不引入 Supabase 新产品 API。

