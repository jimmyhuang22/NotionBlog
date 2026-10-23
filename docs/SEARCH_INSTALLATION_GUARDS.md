# 搜索安装前的结构、权限与配置回退核查方案

本方案接续[安装前核查](SEARCH_INSTALLATION_PREFLIGHT.md)。既有身份／登记读取已经消费关闭；基础摘要匹配、版本五在当时快照空缺，不等于当前结构或底层权限通过。本轮仅完成离线方案与虚构数据库验证，没有获得或执行新的真实查询、安装、配置读取或启用。

## 拟议的单次结构与权限读取

私人目录已固定一条 SELECT 草稿和摘要。采用同一已确认的原连接器时，拟限定一个工具调用、代理零重试、128 KiB 结果 JSON；异常、身份不符、缺项或超限即结束，不补查询。连接器无法强制物理连接数、TCP 接收、客户端截止、事务只读或语句限时，内部重试实现未知。本方案不沿用旧客户端窗口的计量结论，尚未创建执行入口、nonce、截止或预算。

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

## 配置与实例回退前像

私人模板逐项保留“未读取”，区分未知、显式设置与确实未设置。它记录运行负责人、实际部署／构建提交及实例代次，限于以下非凭据字段：

- `CONTENT_PROVIDER`、`DATABASE_CONTENT_VERSION`、`DATABASE_READ_PROJECTION`、`DATABASE_PUBLICATION_MODE`。
- `DATABASE_SEARCH_PROJECTION`、`DATABASE_SEARCH_CONTEXT`、`PUBLIC_CONTENT_CACHE`。
- 如直接构造 repository，记录实际 scoped／filteredSearch／filteredScopeSearch／searchContext 选项及其源码绑定。

本轮不读取云端环境、保护配置或凭据，不用代码默认值填入实际运行配置。新增结构查询也不包含配置读取；实际前像的获取方式、有限调用和负责人须另行明确。

未来回退恢复确切前值，原来未设置的字段恢复为未设置；保留原 publication、上下文及缓存选择。使用受检旧模式创建新实例，排空旧实例和在途请求，再验证实际选择的 SQL。仅修改当前 shell 或环境存储不代表已有实例完成回退。

通常保留未使用的可选 SQL。若另行决定卸载，先确认 owner、签名、摘要与依赖，使用 RESTRICT，仅涉及三个新函数与对应版本五登记；未知结果立即停止，不自动重试、CASCADE 或覆盖。安装、登记、reader 验收、应用启用、卸载和 Git 发布各自需要明确范围。

## 当前离线证据与下一项

六组本机 PGlite 验证覆盖：严格只读事务中的有界元数据读取且不导出虚构正文、受限 reader 拒绝、候选占用及匹配摘要仍停止、权限／RLS 与实际新增列漂移、真实目录数量超限、身份／摘要／重复行／主版本／字节异常拒绝。样本约 39 KiB；这不是实际环境结果或安装后验收。

下一项可单独批准固定结构 SELECT，或先确定能强制连接／字节／截止的受保护安装通道；配置前像仍独立安排。两个旧目录窗口及身份／登记窗口保持关闭，S13 十八次请求草案仍未获准。候选与来源行均默认关闭，发布请求打开期间的 develop 暂停规则继续执行。
