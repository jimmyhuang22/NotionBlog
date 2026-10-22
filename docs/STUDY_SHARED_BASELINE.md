# 首次启动共用完整内容回读

[完整内容基线](CONTENT_BASELINE.md)会独立核对全部栏目、私有正文、来源证据及全部 eligible 媒体描述。首次同时建立普通缓存和[学习检查点](STUDY_BASELINE.md)时，可以复用这次已经核对的学习记录，避免第二遍数据库正文回读。

```ts
const result = await initializeStudyAndContentBaseline({
  content: {
    baseline: { state, records: collection.records, media },
    fullRunId: acceptedFullRunId, store: contentStore,
    reader: createDatabaseContentBaselineReader(binding.reader),
    maxReads: 2000,
  },
  collection, config, deniedPageIds, studyStore,
}, signal);
```

入口在 `scripts/website-incremental-sync/study-shared-baseline.ts`。主运行器已经持有 canonical 锁，传入同一次完整采集、成功发布的 UUID、实际独立 reader 和两个尚未初始化的私有 SQLite store。没有默认配置、来源调用、下载、上传、SQL 写入、队列确认或调度操作。

## 一次回读的边界

先冻结工件和来源／deny 配置，验证学习父链、排序和摘要，要求学习 companion 的完整 records 与普通基线 records 完全一致。不同采集、损坏的 companion 或不同 scope 在数据库回读前拒绝。

随后调用既有 `initializeContentBaseline`，仍独立读取全部十种类型的成员目录，以及每页的私有记录和 owned media。缺普通栏目、漏 eligible 描述、正文／归属错误、未授权 reader、超限、版本／政策变化或取消都不能开启学习复用。它成功初始化普通缓存后，才把本次调用中保留的真实目录和学习页结果交给既有 `initializeStudyBaseline`。外部 receipt、布尔值或 public DTO 不能创建这条复用路径。

学习目录、完整父链、数字覆盖与正文顺序的验证继续执行；安装学习检查点前后仍由实际独立 reader 读取当前全局状态，并与完整基线的 revision、config、schema、policy epoch 逐项一致。不能仅因 fullRunId 相同而忽略全局 revision。复用结果只存在本次调用的内存中。

返回 `content` 为完整基线原回执；`study` 包含版本、课程数、笔记数和 `reusedPageReads`。`databasePageReads` 是实际数据库逐页回读次数，不包含目录和状态查询，也不代表底层 SQL 请求总数。例如四页中两页属于学习：逐页数据库回读四次，两条学习结果复用，成员目录查询一次；状态查询仍保留。

## 中断与重启

两个 store 各自使用既有 SQLite 事务，跨文件安装不是一个原子事务。普通缓存安装后，取消、政策变化或学习安装失败可能留下普通缓存已初始化、学习检查点缺失的状态。不能重跑组合入口覆盖普通缓存，也不能删除已安装缓存或只改版本字符串。

主运行器验证已有缓存版本后，只对缺失的学习 store 使用既有 `initializeStudyBaseline` 和实际独立 reader；恢复时允许对缺失学习基线再次回读。相反，仅普通 store 缺失时使用 `initializeContentBaseline`。两者都存在时核对并直接加载，正常周期不调用首次初始化。外来发布或政策改变应停止并走显式基线对齐。

## 验证与接入

本机 PGlite 的真实完整 publisher、受限 reader／writer 角色和真实 SQLite 验证混合栏目、未引用但 eligible 的媒体、一次完整回读、重开、坏 companion、缺普通栏目、预算、正文与媒体错误、政策变化、取消后只补缺失 store、异步输入变更和 writer 冒充 reader。来源与资产均为虚构数据；没有验证真实 TCP／TLS、Notion、对象字节或线上启用。

主运行器消费本接口，不复制既有基线模块；第一次完整采集和目录元数据种子仍共用原来的工件。本项不改其 host／CLI、queue、媒体、前端或当前真实完整发布任务。
