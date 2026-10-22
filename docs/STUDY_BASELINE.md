# 学习增量的首次完整基线

学习[可恢复检查点](STUDY_INCREMENTAL_RUNTIME.md)的启动入口。完整发布采集同时保留学习排序，发布后由独立 reader 核对整个学习目录和逐页私有记录，再初始化既有检查点。仅提供后台适配，不读取默认配置、安装运行器或发起真实发布。

## 在一次完整采集中保留排序

`collectWebsiteStudyBaseline(options, deniedPageIds)` 替代这次完整发布原有的 `collectRecords(true, deniedPageIds)`，返回 `{records, baseline}`。`records` 是交给完整 publisher 的同一组私有记录；`baseline` 保存数字覆盖、子页相对顺序、来源配置摘要、合并后的 deny 摘要以及记录／学习项摘要。不要先调用本函数，再调用会另行采集的旧 `runWebsiteSync`。

这次采集必须配置所有课程来源为 `all`，对应笔记来源为 `course-descendants`。旧的课程允许名单、固定单课笔记配置或遗漏自动笔记来源会在访问 Notion 前拒绝。实际拥有关系、祖先撤回、未知来源及数据库权限仍由既有解析器检查；普通链接和引用不会成为新公开页。

排序信息来自本次采集中已经读取的页面元数据，课程／笔记正文及媒体注册不额外重读。子页初始 position 使用完整目录 preorder 的 ordinal，保留兄弟相对顺序；后续增量读取父页时会更新为当次正文位置。数字覆盖仍只影响目录第一层。采集失败或学习正文遍历／媒体不完整时不返回基线，缺少未知日期等可空信息继续保留 null。

`records` 已移除学习项中的导航用 `/study` 面包屑，与现有完整 publisher 的私有载荷处理一致；公开 DTO、网站导航和前端组件不变。完整采集同一次生成的 records 和 baseline 应一并保存到主运行器的私有基线工件中；本模块不另建普通栏目缓存或文件系统协议。摘要用于完整性核对，不代表独立 reader 证明。

## 发布后建立检查点

主运行器持有 canonical 互斥，并完成完整批次发布后，再执行：

```ts
const result = await initializeStudyBaseline({
  collection, config, deniedPageIds, fullRunId: acceptedFullRunId,
  store, reader: createDatabaseStudyBaselineReader(binding.reader),
  maxReads: 2000,
}, signal);
```

`deniedPageIds` 必须是本次来源选项和发布 lease 的完整合并名单。reader 是已通过真实角色、TLS 和能力预检的独立连接；不能传 writer 或用自行填写的布尔标志当回读。本次完整批次 UUID 要由成功的完整发布过程提供，不能用后来增量的 operationId 冒充。

初始化先冻结输入，核对配置、摘要、完整父链、全部学习记录与排序，再检查实际发布状态。首次发布的 UUID 必须仍是当前批次；冒号后的 revision 是数据库全局版本，不能假定为零。独立读取一次学习元数据目录，要求 ID 集合和基线完全相等；公开元数据仅提供成员集合，不能替代私有正文／证据。随后对每个学习页调用既有私有 `readPublishedRecord`，精确比较正文、元数据、来源、祖先与 ordinal。最后再核对发布版本、schema、配置和 policy epoch，才调用检查点的 `initialize`。

`createDatabaseStudyBaselineReader` 直接组合既有 `published` 元数据投影、增量状态和私有逐页 reader API。目录读取不含正文；逐页回读只用于第一次基线核验，不访问 Notion、原图或小图，不新增 SQL capability／权限。默认最多 2,000 次逐页回读，显式上限 20,000；目录和两次状态读取另计，逻辑页读取数不等于实际 SQL 请求数。主运行器仍负责物理请求预算与连接取消。

初始化成功返回版本、课程数、笔记数和实际逐页回读数。任何缺页、重复目录 ID、缺 reader 证明、正文不一致、版本／政策变化或取消都会停止，留下未初始化的检查点。已经初始化的不同检查点不能被新基线覆盖；同一基线可幂等确认。日常重启读取已有检查点，正常增量不会再执行全目录／逐页基线核验。

## 验证和剩余接入

合成来源验证两门课程、日期／数字排序、正文子页顺序、祖先 deny、配置与工件损坏、完整目录成员、读取预算、取消、输入冻结及 SQLite 重开。实际本机 PGlite 完整 publisher、受限独立 reader API 和 SQLite 共同验证接受基线；没有模拟 SQL 成功标志替代回读。

主运行器还须在其单次完整发布入口消费这组 records，保存私有工件，连接实际来源、资产索引和独立角色，并在接受完整新基线后初始化。当前没有安装真实全课程检查点，也没有改 Dagu、云库、媒体对象、栏目开关、main 或网站部署。已验证的旧媒体继续复用，不为建立学习检查点重新下载／上传整库图片。
