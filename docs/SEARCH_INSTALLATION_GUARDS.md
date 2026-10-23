# 搜索安装前的结构、权限与配置回退核查方案

本方案接续[安装前核查](SEARCH_INSTALLATION_PREFLIGHT.md)。既有身份／登记及两次超限读取均已消费关闭。用户另行批准触发器上限 128 的第三版固定 SELECT 后，已单次执行并关闭额度；真实结果与审阅结论保存在忽略的私人交接中。元数据许可不包含公开这些实测细节，也不授权安装或配置读取。

## 第一版结构读取的批准范围与结果

用户另行批准原连接器的一条固定 SELECT：一个工具调用、代理零重试、128 KiB 结果 JSON；异常、身份不符、缺项或超限即结束，不补查询。连接器无法强制物理连接数、TCP 接收、客户端截止、事务只读或语句限时，内部重试实现未知，不沿用旧客户端窗口的计量结论。

实际仅提交一次调用，返回 CATALOG_LIMIT_EXCEEDED、scopeComplete=false 的 100 字节紧凑 JSON；没有返回各类计数，不能确定哪项超限，也不把它推断成字节超限或权限失败。结果未作为结构、身份、权限或登记核查通过；许可已消费关闭、剩余零，未重试、追加探针或追溯接受旧快照。授权、原始回执和拒绝记录仅留私人目录，见[执行记录](progress/2026-10-23-search-structure-limited-read.md)。

除版本登记外只读取以下白名单的系统目录，不读取内容、发布批次、状态行或媒体：

| 类别 | 固定范围与上限 | 返回内容 |
| --- | --- | --- |
| schema | `nb_read`、`nb_read_api`、`nb_v2`、`nb_publication`，最多 4 项 | owner、ACL、当前安装身份的 USAGE／CREATE 布尔 |
| 表 | `nb_read.migrations`；`nb_v2.state`、`runs`、`records`、`media`、`denied`；`nb_publication.state`，共 7 项 | 表种类、owner、ACL、RLS／FORCE RLS、当前身份的 SELECT／INSERT／UPDATE 和行类型 USAGE，以及指定角色的有效 SELECT 布尔 |
| 列与结构 | 列最多 160；约束／索引各 64；策略／触发器各 32 | 列序、名称、类型、可空性、生成标记；默认式、约束、索引、策略表达式和触发器仅返回定义摘要及必要标记 |
| 函数 | 上述四个 schema，最多 96 项 | 签名、返回类型、owner、ACL、definer、volatility、search_path、配置／定义 SHA256，以及指定角色的有效 EXECUTE 布尔；不导出函数正文或任意配置值 |
| 角色与授权 | 固定最多 7 个相关角色、最多 64 条与其直接相邻的成员边；当前安装者全局／四个 schema 默认 ACL 最多 32 项 | 角色属性、继承／SET／管理选项与默认权限；不读密码或自称完整角色图 |
| 安装辅助权限 | SQL、PL/pgSQL 两种语言 | 当前身份的 USAGE 布尔 |
| 登记 | 版本 1–5，最多 5 行 | 版本及文件摘要，与本次目录在同一语句快照核对 |

输出只要超过任一类别或 128 KiB，就返回不完整标记，不接受截断。列、约束、索引、策略与触发器的“完整”仅指上述七张表的列明类别，不代表全库备份、全部依赖或业务数据前像。定义摘要与迁移文件字节 SHA 不互相替代。

目录与权限接口以 [PostgreSQL 17 权限查询](https://www.postgresql.org/docs/17/functions-info.html)、[列目录](https://www.postgresql.org/docs/17/catalog-pg-attribute.html)、[策略目录](https://www.postgresql.org/docs/17/catalog-pg-policy.html)和[函数目录](https://www.postgresql.org/docs/17/catalog-pg-proc.html)为依据。有效 SELECT 权限还须结合 owner、角色 bypass／superuser、RLS／FORCE RLS 与策略审阅；不能单凭 owner 名称或 has_table_privilege 判定实际读取资格。

## 收到结果后的判定

先验证身份、数据库与服务端主版本、范围、数量、唯一对象、摘要格式和完整性，再核对基础 1–3 文件摘要及三个候选函数／版本五占用。任何候选同名对象或版本五存在，都先停止辨认归属，即使登记摘要相同也不重装或覆盖。

当前安装身份须具备新函数所需 schema／语言／类型权限、登记写权限及底层读取条件；既有依赖函数也须存在且权限与 owner 可解释。列结构漂移、强制 RLS 或未知策略、成员关系、默认 ACL、函数定义变化都保留给人工审阅，不用自动补 GRANT 或角色切换修复。

离线解析器即使接收完整结果，也始终返回“安装未授权、仍需 owner 人工审阅”。PGlite 的结构样本仅用于验证解析与拒绝路径，不作为真实 PostgreSQL 17 的目录摘要基线。未来安装仍须重新绑定目标、源码、当次前像与占用状态；一次查询不提供锁或未来状态保证。

## 托管迁移的事务边界

迁移源文件摘要与实际执行载荷摘要分开记录。源文件中的 BEGIN／COMMIT 适合独立事务执行，不应直接嵌入另一个迁移运行器的事务；内部 COMMIT 可能先提交应用对象，后续平台迁移历史写入失败也无法撤回，见 [Supabase 的说明](https://supabase.com/kb/troubleshooting/partial-migrations-and-schema-inconsistencies-from-embedded-transactions)。不修改冻结源文件来掩盖执行载荷变化。

托管通道使用另行受检的事务兼容载荷：不自行提交／回滚服务事务，以 SAVEPOINT 要求服务已提供事务，把应用变更及前后校验放在同一 DO 中，再 RELEASE SAVEPOINT。缺少外层事务时先拒绝；原功能 DDL 正文和能力源摘要保持绑定，载荷另有独立摘要。SQL 文本只证明自身的边界，不证明已部署服务的历史写入时序、身份、内部重试或物理传输保障。

平台迁移历史是应用版本五之外的独立范围。除 owner、ACL、列与当前身份权限，还须审阅其约束、索引、默认表达式、触发器及附属函数、策略和规则；未审回调或特殊结构先停，不执行函数或读取平台存储 SQL 来试探。应用事务的本地回滚证明不能扩大为平台历史全链原子性。实际安装、后验核对与摘要登记分别列明范围，不因前一阶段成功自动推进。

## 应用摘要登记与受限能力核对

应用摘要登记只把版本五的 NULL 通过单行 CAS 改为原功能迁移 SHA，不登记执行包装的 SHA，不覆盖任何非 NULL 状态，不重放安装或新增平台迁移历史。登记走原始 SQL 的 DML 通道；所有应用检查、更新和更新后检查放在同一个 DO 内，超出预计行数或任一检查失败即拒绝。前置 SET LOCAL 必须在 DO 开始前有效，载荷不自行 BEGIN／COMMIT／ROLLBACK；通道丢弃前置设置时先拒绝，不借成功返回推断传输保障。参见 [DO](https://www.postgresql.org/docs/17/sql-do.html) 与[简单查询中的多语句事务](https://www.postgresql.org/docs/17/protocol-flow.html#PROTOCOL-FLOW-MULTI-STATEMENT)。

候选函数源、owner、ACL、基础登记及受检目录继续核对，并精确绑定本次原生迁移的 version／name，不读取其已存 SQL。登记表的触发器、重写规则、默认项或未审特殊结构先停；后验补充旧目录清单未包含的登记表重写规则检查。检查只保护列明范围，锁不冻结全库和角色。

受限能力核对以事务内指定 reader 角色调用基础及版本五的登记检查函数，不查询正文或内容搜索函数。它只证明该假定角色能通过能力检查、不能直接执行私有 helper 或读取登记表，不证明网站实际登录、TLS、运行配置、内容资格、DTO 或性能。登记会让已配置相应路径的授权客户端通过版本检查；不把“未改配置”写成所有外部客户端均未使用该能力。

诊断工具按项目和类型返回 advisories，没有按对象过滤或条数限制参数，不能把客户端筛选写成服务端只审阅本次函数。项目级元数据及可能的 SQL 片段须列入独立范围，结果有界私存；发现项先按预期架构判断，不自动改权限、删除索引或修复。没有之前的诊断基线时，不把本次发现标为新引入，见 [Supabase Advisors](https://supabase.com/docs/guides/observability/advisors)。

## 配置与实例回退前像

私人模板逐项保留“未读取”，区分未知、显式设置与确实未设置。它记录运行负责人、实际部署／构建提交及实例代次，限于以下非凭据字段：

- `CONTENT_PROVIDER`、`DATABASE_CONTENT_VERSION`、`DATABASE_READ_PROJECTION`、`DATABASE_PUBLICATION_MODE`。
- `DATABASE_SEARCH_PROJECTION`、`DATABASE_SEARCH_CONTEXT`、`PUBLIC_CONTENT_CACHE`。
- 如直接构造 repository，记录实际 scoped／filteredSearch／filteredScopeSearch／searchContext 选项及其源码绑定。

本轮不读取云端环境、保护配置或凭据，不用代码默认值填入实际运行配置。新增结构查询也不包含配置读取；实际前像的获取方式、有限调用和负责人须另行明确。

配置前像分为项目设置、部署／实例实际状态和直接构造选项，不能互相代填。[Vercel 环境变量说明](https://vercel.com/docs/environment-variables)明确环境变量变更只作用于新部署；读取当前项目设置不能证明旧实例的实际值。[列表接口](https://vercel.com/docs/rest-api/projects/retrieve-the-environment-variables-of-a-project-by-id-or-name)没有按键过滤参数，而[逐项接口](https://vercel.com/docs/rest-api/projects/retrieve-the-decrypted-value-of-an-environment-variable-of-a-project-by-id)需要变量 ID；不能把客户端筛选说成服务端只返回七项，也不把列表缺项当作已证明未设置或不存在继承值。受限结果过滤及拒绝守卫已离线验证。项目设置窗口随后另获明确批准；实际只提交一次名单工具调用，未取得可验收结果即闭窗，没有逐项取值或重试。所有具体回执只私存，见[决定](decisions/2026-10-23-search-project-config-read.md)与[准备及执行记录](progress/2026-10-23-search-runtime-beforeimage-plan.md)。

用户已选择[保留旧部署的应用回退方案](decisions/2026-10-23-search-deployment-rollback-plan.md)：保留已服务生产的旧部署及其原环境，以切回旧部署替代逐项重建不可回读的配置值。未知字段仍记录未知，不用默认值代填、不重设 Secret、不为证明资格先发布。这只改变应用回退前像的实现方式，不代表当前已具备回退条件，也不替代数据库前像、占用、owner 审阅或当次操作授权。

实际变更前须重新绑定旧部署／源码／域名经历、保留状态、套餐限制、操作者资格和外部数据库兼容性，并控制旧→新切换顺序；其他生产切换或证据不足即停。Hobby 仅支持紧邻前一个部署，曾服务生产域名也是资格条件；保留期限不等于可回退期限。平台回退保留目标部署的旧环境，不恢复项目设置或外部数据库；生产域名自动分配及 Cron 的影响须纳入当次方案，见 [Instant Rollback](https://vercel.com/docs/instant-rollback) 与[部署保留说明](https://vercel.com/docs/deployment-retention)。

该路径不更改原项目设置；新测试实例须使用明确、独立、受审的配置及同一受检源码，仅让待比较搜索模式不同，不把未知的旧环境复制给 Preview。回退时先让旧路径承接，再确认候选实例、连接池和在途请求排空；仅修改当前 shell 或环境存储不代表完成。若未来另行选择修改配置／重建实例，仍须保存并恢复确切前值，原来未设置的字段恢复为未设置。

通常保留未使用的可选 SQL。若另行决定卸载，先确认应用已回退及候选实例／连接池排空，再核对 owner、签名、摘要与依赖，使用 RESTRICT，仅涉及三个新函数与匹配摘要的版本五登记；RESTRICT 本身不证明应用排空。未知结果立即停止，不自动重试、CASCADE 或覆盖。安装、登记、reader 验收、应用启用、卸载和 Git 发布各自需要明确范围。

## 第二版固定依赖读取：已消费关闭

保留第一版原始查询和拒绝结果；第二版采用不同摘要与范围标识，仅收窄函数及成员边，其他表结构类别上限、128 KiB 与代理零重试保持：

| schema | 固定函数名（同名重载也返回并计数） |
| --- | --- |
| `nb_read` | current_snapshot、search_parts、search_scope、search_scope_reused |
| `nb_read_api` | read_search_parts、check_capability、check_search_parts、check_search_walk、read_search_filtered_scope、check_search_filtered_scope |
| `nb_v2` | current_snapshot、record_eligible |
| `nb_publication` | current_snapshot |

共十三个固定名称、最多 32 条函数；不再返回四个 schema 的所有函数，也不声称保护了未列明对象的完整目录。成员边仅从 reader、writer 及实际网站 reader 三个角色取直接相邻边，最多 64 条，仍不声称完整角色图。已知源码依赖之外的定义、owner 或授权变化必须人工辨认，不能假设新增依赖安全。

第二版在拒绝标记内附各类别“最多上限加一”的计数，不返回截断对象；达到上限加一只证明已超限，不是实际总数。该设计不能补回第一版没有返回的计数，不把新的本机结果改写为旧真实调用成功，也不自动增加上限或继续提交。

用户另行明确批准后，实际只提交一次第二版调用，返回 278 字节紧凑 JSON。触发器计数为 33、上限为 32，表示当前至少 33 项；其他返回类别未超各自上限。只接受这些有界计数用于诊断，完整结构、身份、底层权限及登记摘要仍未取得或验收，不能据数量推断函数齐全、权限满足或版本五空缺。没有返回触发器清单，不知道实际总数、类型或每表分布，也不把新计数追溯为第一版的确定原因。额度消费关闭、零重试；见[决定](decisions/2026-10-23-search-dependency-read-limit.md)与[记录](progress/2026-10-23-search-trigger-limit-and-timer-test.md)。

## 第三版触发器范围读取：已批准并消费关闭

只把触发器类别上限从 32 调整为 128，超限哨兵计数为 129；十三个函数名／32 条重载、七张表的其他结构类别、成员边范围及 128 KiB 结果保持。原两版 SQL 与验证器不改，不复用已消费许可；第三版具有独立范围标识、固定摘要和本次用户明确批准，不是失败后的自动重试。

本机模型新增二十一个外部引用表后，七张受保护表上会有六十个合法外键触发器，说明通用的 32 项上限可能不足；这只是离线模型，不代表真实环境的超限项均为外键或当前总数为六十。第三版保留全部 internal／非 internal 触发器元数据，不以排除一类触发器来缩减保护；达到 129 时仍拒绝对象结果、只返回有界计数。

实际只提交一次原连接器调用、代理零重试，许可已消费关闭、剩余零。原始回执、实测身份／结构／权限／登记和全部目录摘要只留私人材料；公开文档仅保留批准的查询范围、执行与后续限制。未来操作须由负责人在私人材料审阅本次结果，不能根据公开说明认定任何对象当前空缺或权限成立。

固定只读 SELECT 不等于服务器强制只读或语句限时；物理连接、TCP 接收与内部服务重试仍不可计量，结果 JSON 字节不能当作网络接收量。没有追加 SQL、应用函数、实际配置读取、安装或启用。旧两次失败保持原状态，第一版的超限类别仍未知；见[决定](decisions/2026-10-23-search-trigger-inventory-read.md)与[记录](progress/2026-10-23-search-trigger-inventory-read.md)。

## 离线证据与下一项

第一版六组本机 PGlite 验证覆盖：严格只读事务中的有界元数据读取且不导出虚构正文、受限 reader 拒绝、候选占用及匹配摘要仍停止、权限／RLS 与实际新增列漂移、真实目录数量超限、身份／摘要／重复行／主版本／字节异常拒绝。旧样本约 39 KiB，不能代替本次被拒绝的真实结果。

收窄后的草稿八组本机验证通过：保留原六组语义，并核对一百个无关函数及六十五条 owner 无关成员边不会扩大固定名单、旧真实不完整结果仍被拒绝。其本机样本、身份和权限布尔均不是当前环境的验收。

触发器预算草稿十组本机验证通过，新增六十个外键触发器可完整保留、129 项仍只返回拒绝计数，并确认两次旧真实不完整结果都不能被新解析器补验。该结果不批准实际安装，也不替代 PG17 的真实前像。

下一项先取得运行负责人的覆盖范围审阅，落实上述已选应用回退方案的真实资格／保留／权限及隔离实例条件，再明确具备所需守卫的安装通道、数据库前像、fresh 占用、固定安装／登记与有界 reader 验收；都不由元数据许可或方案选择推导。既有读取窗口均保持关闭，私有观察及任何时限偏差不公开、不追溯补验，S13 十八次请求草案仍未获准。候选默认关闭，来源任务保持原暂停状态，发布请求打开期间的 develop 暂停规则继续执行。
