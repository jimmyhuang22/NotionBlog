# 网站增量变更发现

本模块只发现变化并入队，不读正文／图片、不提交发布，也不安装事件入口或定时任务。它沿用[公共队列](WEBSITE_INCREMENTAL_QUEUE.md)，供[增量执行器](WEBSITE_INCREMENTAL_EXECUTOR.md)和主运行器接线。

## 分页与目录

`createNotionDirectorySource(client, config, expectedDigest)` 接受显式 `getDataSource(id, signal)` 和 `queryDataSource(sdkQuery, signal)`。传输由运行器提供请求节流、截止时间、字节预算和实际取消；模块不读取 Token 或默认环境。每页重核来源 schema、直接物理父级、完整分页状态与配置摘要，队列和 source 的摘要也必须相同。

支持直接 data source 的显式来源，allowlist 来源只收已允许 ID。`course-descendants` 不按课程根表扫描成笔记，学习引擎负责实际拥有的后代；普通 `page` 和已知深层页可用下述定点端口。目录不是学习层级或完整内容缓存。

`runDirectoryDiscovery(options, source)` 默认每轮最多 10 步／120 秒，变化窗口重叠 5 分钟，每 24 小时补查成员目录；可显式请求 membership。先继续未完成扫描，不以新时间替换旧扫描边界。变化查询按 last_edited_time 升序，包含从已完成 watermark 减去重叠时间，到本轮开始时间的闭区间。相同时间戳可保留，目录指纹相同不重复入队。迟到的旧元数据不覆盖较新版本。

首轮与定期 membership 不设编辑时间过滤，否则分页期间编辑的现有页可能被当成缺失。目录只保存页键、编辑时刻、元数据摘要与扫描身份；属性值参与摘要但不保存原值，可发现同时间戳的属性变化。Notion file 的签名与到期时间不参与摘要，外部链接保留完整身份；对象键顺序不影响比较。目录不保存标题、属性正文或临时图片 URL。指纹不是内容已发布的证明，队列仍重新准备获准页并由独立 reader 比较。

目录、扫描状态与已见游标摘要随 SQLite v2 增加，当前 v3 另有[领域退役待办](WEBSITE_INCREMENTAL_LIFECYCLE.md)。旧队列在同一事务升级，保留事件、检查点、代次和未知提交身份。每个成功响应的目录变化、生成事件、下一游标同事务写入。CAS 阻止并发旧响应覆盖；游标循环、截断响应、未知成员结构或错误范围不推进该页。目录最多 20,000 条／来源，响应最多 200 行、扫描最多 200 页；SDK 适配实际每页最多 100 行，不自动提高上限。

Notion 查询可能以 `has_more=false` 结束截断结果，因此适配器也检查 `request_status`；出现 incomplete 时停止，不把截断目录当完整。大来源需要另做分区设计。[Notion 查询说明](https://developers.notion.com/reference/query-a-data-source)

## 完成与恢复

`createKnownPageDirectorySource(client, config, state, catalog, batchSize?)` 接同版本、同摘要、readerVerified 的私有已知页目录；只用于配置普通 page 或 course-descendants。按规范 ID 排序、以目录身份摘要绑定游标，默认每批 20 个 getPage、最多 50；沿用扫描 200 批限制，超容量须另设计分区。学习还重新核对配置课程根 schema，普通 page 只接受它的显式 ID。它不 listBlocks／listPages，不只看课程根编辑时间。运行器须提供当前验证目录、预算和实际取消。

正常与不可用 ID 在同一目录事务中记录；null 只生成去重 reconcile，保留旧指纹并标待核，再可用时重新入队，不产生删除证据。目录身份变了不能沿用旧 offset，需要显式恢复扫描。已有目录正常未变不发信号，首次未种元数据则产生初始信号；不能用新读元数据把历史内容假定为已同步。此端口轮巡已知页，不独立发现新后代；新拥有页仍由学习发现／可信事件提供。

完整 membership 查询后进入 missing 阶段，每步最多 100 条（底层上限 200）把未见成员送入 `reconcile`，并保留待核标志。缺失可能来自移动、删除或权限变化，**不直接形成撤回证据**。后续领域准备检查当前范围；未知权限保留待核，明确撤回再由发布协议处理。扫描不是源端事务快照，不能作为永久删除的证明。

全部分页及 missing 处理完成后才推进 watermark 和成员核对时间。中途失败保留已成功的页级信号和断点，下次从原游标继续。返回值只有 outcome、页数、hint 数和稳定错误码。超时／外部取消停止等待，迟到响应不写目录；传输仍必须实际响应取消。

`queue.discoveryState(sourceKey)` 提供私有扫描状态；`directoryPage(sourceKey, afterKey?, limit?)` 有界读取目录。坏游标需要显式 `restartDiscovery(sourceKey, expectedRevision)`，保留上一完成 watermark 和已有信号；不因远程查不到游标而跳到当前时间。现有通用 commitDiscovery 检查点接口仍保留。

## 运行边界

首次目录没有历史元数据时会对新见页面发 created 信号。运行器应结合已验证的既有基线安排初始化，不能把刚读取的元数据直接当成内容已同步。元数据轮巡不保证发现所有块结构或未知后代；明确事件信号始终应入队，由学习与领域适配器补查。Webhook 验签／公网入口、新后代完整发现和正式运行器不属于本模块。

本地验证使用虚构 SDK 响应和私有临时 SQLite，覆盖中断恢复、同事务回滚、并发 CAS、相同时间戳、成员缺失、游标循环、v1 升级保留未知提交、截断／范围／schema、取消以及变化信号到既有执行器。没有真实 Notion、云 SQL、媒体读写、完整采集或 Dagu 修改。
