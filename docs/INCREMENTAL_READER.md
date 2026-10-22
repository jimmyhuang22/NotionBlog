# 增量内容读取与发布确认

增量执行器需要比较单页的上一已发布版本，也需要在收到提交回执后独立确认实际生效结果。这里提供受限 reader 的私有接口；不返回全库正文，不访问 Notion，不将写入回执当作任务完成。

## 接口

`src/server/database/incremental-reader.ts` 接受原始 reader `SqlExecutor`（不用 `publicationReader` 包装），可传 `AbortSignal`：

| 入口 | 结果 |
| --- | --- |
| `verifyIncrementalReader(reader, signal?)` | 核对持久发布、增量提交和新 reader 扩展的能力摘要 |
| `readPublishedRecord(reader, {pageId, sourceKey, expectedRevision}, signal?)` | 单页 `WebsiteRecord`、其 `StoredMedia[]`、版本、配置／schema 摘要与 `readerVerified:true`；不存在或已撤回返回 null |
| `verifyPublishedDelta(reader, receipt, signal?)` | 使用独立读权限检查操作身份、摘要、当前版本、实际变化正文／证据／媒体与撤回；匹配返回 true，未匹配返回 false |

页面版本必须是当前服务器 `runId:revision`。版本过时抛 `DELTA_VERSION_CHANGED`，内容／政策／能力不可用抛 `DELTA_READER_UNAVAILABLE`，不泄露连接信息或正文。父页面 deny 同样使其后代不可读取。单页包最多 16 MiB，保留原证据和 ordinal 供后台比较／准备重用。

返回的 source evidence 和存储描述是**私有同步数据**，不能作为浏览器 DTO、HTTP 通用详情或公开导出。前端仍通过原统一 repository 读取过滤后的内容。

## 队列接入

内容准备的 `readPublished(ticket,state,signal)` 可调用单页接口，传 ticket 页面／来源和 state 发布版本。执行器的 `verify(receipt,signal)` 接 `verifyPublishedDelta`；仅 true 后才调用本地 `confirmCommit`。

提交响应丢失时先用原 operationId／payloadDigest 查询 writer 账本，再独立 reader 核对。查询 null、网络异常或 reader false 都不能当作“没有写入”，不能换 operationId 重发。这个接口严格确认同一当前发布版本；更晚发布或中央 deny 已改变版本时保留待核对，后续需要明确的任务代次／替代版本恢复策略，不自动确认旧操作。

本接口核验数据库正文、引用与范围；不逐张下载对象，也不证明 CDN 或目标地区网络可用。媒体准备仍负责提交前的实际字节核验，发布验收另做原图／小图／正文链路检查。提交的媒体描述必须属于本次最终保留的引用；准备额外但未使用的描述被 SQL 裁掉后，reader 不会为该载荷出具匹配证明。

增量 publisher 的确定拒绝只识别 PostgreSQL `P0001` 的已知稳定码。原 scope／媒体／完整性拒绝映射 `DELTA_INPUT_INVALID`，学习依赖缺失保留 `DELTA_DEPENDENCY_MISSING`。执行器拒绝分类应包含这项依赖错误并转人工复核。网络错误即使带有相同文字，仍属于 `DELTA_UNAVAILABLE`，不能误清除待核对标记。

## 安装与验证

迁移 owner 在匹配的 v2、持久发布和增量提交扩展之后运行 `npm run website:sync -- migrate-incremental-reader`。安装不启用来源、激活发布或安装调度；重复安装仅核对已登记摘要，摘要漂移拒绝。

三个新 SQL 函数只授予 reader；writer、匿名、authenticated、service_role 均不可读取这份私有投影，也无操作账本表权限。新迁移只处理自己的 grants，不撤销既有 writer 提交／恢复能力。固定 `search_path` 的安全定义函数与角色最小权限参照 [Supabase 数据库函数说明](https://supabase.com/docs/guides/database/functions)。

PGlite 测试真实安装 SQL、独立角色和默认宽泛 grants，覆盖单页证据／旧图复用、正文变更、丢回执恢复、qualified 到期、撤回、祖先 deny、过时版本、数据库实际内容不匹配、后续发布、协议漂移、非法输入和取消。所有内容为 fixtures，无真实来源、对象传输或云迁移。首次真实运行仍需要来源发现、学习 checkpoint、媒体适配、备份恢复和阻断 Notion 的完整验收。
