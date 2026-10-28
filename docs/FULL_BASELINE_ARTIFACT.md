# 首次完整发布的增量工件

主增量运行器需要同一次完整发布的内容、学习排序、媒体描述、目录元数据与实际接受的发布状态。可选 worker hook 在原有完整采集内保留这些信息，不再为了制作工件另采正文或重新处理图片。旧 worker 不传 hook 时仍走原有路径；没有启用现有运行包、计划或云配置。

## 一次采集，先保存再发布

```ts
await runWebsiteSync({
  client, config, mode: "publish", writer, storage, download, signal,
  onIncrementalBaseline: async capture => {
    await savePreparedFullBaseline({ directory: artifactDirectory, config, capture }, signal);
  },
});
const result = await sealFullBaselineArtifact({
  directory: artifactDirectory, config,
  reader: createDatabaseContentBaselineReader(binding.reader),
}, signal);
```

调用方已有 canonical 锁、实际受限发布 writer、独立原件 storage、已安装的自动学习及持久发布能力、Source／媒体预算和取消控制。hook 只接受 `publish`、完整自动课程与对应后代来源，以及全部原件入 storage 的路径；旧单课名单、dry-run、stage、混合 Notion 媒体模式不能生成启动工件。程序不会替调用方安装能力或扩大实际来源。

配置核对在 lease／Source 请求前完成。启用 hook 后，现有一次 collector 换成 `collectWebsiteStudyBaseline`，同一媒体 callback 完成既有下载、字节校验和存储。`captureDirectoryMetadata` 只观察这次原本已有的元数据调用。完整正文检查之后，封存同组 records 的目录 companion，把 `PreparedFullBaseline` 的独立副本交给 hook；callback 不能改动将要 stage 的 records 或媒体。

`savePreparedFullBaseline` 保存私有 `incremental-prepared.json`：格式、真实 fullRunId、scope digest、collection、全部媒体描述、合并 deny 与目录 companion。它没有已接受状态，不是增量初始化输入。保存必须在任何 SQL stage／promote 前成功；失败或取消停止发布，既有媒体对象可能已经按原 worker 流程保存，但不因工件文件存在而公开。

## 接受确认与丢失回执

`sealFullBaselineArtifact` 从准备文件读取原始同次工件，验证配置、学习图／排序、来源、媒体归属与目录成员／摘要。独立 reader 的当前状态必须属于该 fullRunId，精确匹配 scope 和 schema；后缀是全局 revision，不假定为零。随后使用 reader 专属的完整成员目录能力，核对所有栏目页 ID 和全部 eligible 媒体 ID，最后再核对完整状态与 policy epoch 未变。

单独读取状态不够：writer 也有这个能力。成员目录 API 的实际 reader 权限边界继续执行；不能用 writer 或自填 `readerVerified` 当作连接验证。目录只含元数据，不执行私有正文回读，也不读取媒体字节。调用方必须从已经通过实际 LOGIN／TLS 绑定的独立连接创建 reader。

封存成功生成 `incremental-baseline.json`，恰好七项字段：`format=incremental-baseline-v1`、fullRunId、state、collection、media、deniedPageIds、directory。它是主运行器 `initialize --artifact ...` 的输入，不是完整 raw-reader 证明、对象存储覆盖证明或公开授权。运行器仍执行 [完整内容／学习共用回读](STUDY_SHARED_BASELINE.md)与[目录种子](WEBSITE_DISCOVERY_BASELINE.md)验证；本步骤的成员查询不能替代实际正文／证据／媒体描述核对。

promote 回复丢失、或发布成功后本机封存中断时，保留准备文件，只再次调用 seal；不重新调用完整 worker、不重读 Notion、不重下图片、不盲重发 promote。不同批次、未接受的运行、撤回导致成员不同、版本／政策变化均拒绝封存，交由调用方调查。操作旧已接受批次时也不能只更换 UUID 或 state 字符串。

## 文件与取消

显式 canonical 私有目录为 700，文件为 600，单文件最多 48 MiB。完整记录、学习项及媒体沿用既有上限；目录只存允许成员的元数据指纹和时间，不保存任意私有属性。准备和接受文件均原子安装、不可覆盖；同一内容可幂等重试，不同内容冲突，宽权限、符号链接和多链接文件拒绝。临时安装链接在返回前移除，最终文件 link count 为一。

文件和父目录都会 fsync。取消不会发布部分 JSON；可能留下已完整安装但尚未返回成功的文件，下次按内容核对继续。新增 worker signal 在 lease／媒体回调／工件保存／SQL 边界检查；底层 Source、下载及 SQL 取消仍由调用方提供的预算运输端口执行，不把这个字段当成正在进行的网络请求已经停止。

若进程在临时安装链接移除前被强制终止，多链接状态仍会拒绝读取，须核查并处理该次中断；不能把存在的文件或未知链接直接视为完成。

## 验证与剩余工作

虚构 Source／storage、实际本机 PGlite 完整 publisher 和受限角色、真实三个 SQLite 验证同次四页／一媒体工件、数字覆盖和深层页、与旧路径完全相同的 Source 调用、只一次下载与保存、接受后双缓存及目录初始化。另验丢回复恢复、保存失败不 stage、callback 输入隔离、取消、旧模式拒绝、政策变化、工件损坏、文件不可覆盖／权限／多链接，以及 writer 无权封存。

与已合入的主运行器直接联通：通过实际受限 LOGIN 绑定，以本机 publisher 的同次工件调用 `runIncrementalHost initialize`，三页只回读三次 raw记录，没有 Source／storage工厂请求，连接全部关闭。这是本机 SQL运输和虚构来源的接线证据，不是实际云 TCP／TLS或 Notion验收。

没有实际 Source、图片、云 SQL、完整发布、安装、调度、main 或部署操作。主运行器／安装拥有方仍须在获准的首次完整发布中接入 hook，使用真实独立存储与运输预算，并在成功封存后消费工件；现有单课发布任务不会自动改用此入口。


## 接续已有恢复采集

已有恢复器产生完整 `collection-private` 时，可使用 `prepareCapturedBaseline`，复用该次记录、正文、媒体与顺序。它只复核课程与直属笔记的排序元数据，调用现有 SourceReadProof 比较同一版本，不能采集正文或下载图片；没有记录到的目录指纹明确标记为 skipped，交给正常发现处理。未完成采集、来源或元数据变化时拒绝。生成的仍只是 prepared 输入，后续 seal 和完整独立 reader 证明全部保留，不能将旧过期批次或本机文件当作公开授权。

`copyCapturedMedia` 可将已校验本机字节去重复制到已配置独立存储，不解析源地址、不改 SQL 或发布指针。调用方持既有锁并持久记录 sending／stored；回执不明立即停，已确认成功对象不重复写。复制和元数据整理都不是再次完整同步。基线就绪仍要求当前来源、持久指针、独立媒体及实际读回全部匹配。
