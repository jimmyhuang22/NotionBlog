# 首次完整发布运行入口

`node scripts/website-incremental-sync/full-baseline-cli.ts publish|seal|status` 将已有完整发布器、[同次工件](FULL_BASELINE_ARTIFACT.md)与主增量运行器接通。需要 Node 24；它不安装云能力、配置公开政策、部署网站或替换原计划。

## 显式输入与目标

publish／seal 必须显式提供 `--config`、`--lock-dir`、`--artifact-dir` 绝对路径。来源文件为私有 600，工件目录为私有 700，每次完整发布使用单独目录；锁必须是旧固定运行入口实际的 canonical stateDir，与增量 host 共用。不能使用 privateRoot 另造锁，也不能将工件目录作为锁目录。

必需环境为 `SYNC_PUBLICATION_MODE=published`、`SYNC_MEDIA_PROVIDER=storage`、`SYNC_READER_DATABASE_URL`、`SYNC_DATABASE_URL`；TLS／CA 使用现有显式配置。reader／writer 为分别继承受限组的实际 LOGIN，同目标、数据库与租户。检查实际角色成员、管理及所有权、私表权限、API 授予与已安装协议。首次完整发布不要求已有持久指针，但固定 begin API 仍验证实际配置的 scope；普通增量入口仍要求已有接受状态，没有新增跳过开关。

**publish 是真实写入命令。** 完整 promote 同时推进既有 qualified 批次和持久指针。不能在正在服务旧配置的生产库随意尝试新的范围与 storage 模式；先用隔离目标完成验收，或由发布负责人安排已审阅的数据库／网站／媒体切换。合并本 PR 不执行 publish。

publish 才需要 Notion 与受限独立对象 writer。Supabase、可选 [COS](COS_MEDIA_STORAGE.md)、loopback storage、cache／originals、HEIC converter 沿用同一对象接口；对象 fetch 绑定全局取消。Supabase 可通过已接线的受限 [会话适配](WRITER_STORAGE_SESSION.md)续期；未选择该适配的固定 JWT 须覆盖整轮窗口。COS 使用独立受限凭据，临时凭据也须覆盖整轮；桶版本状态在 Source 前实际核对。COS 代码存在不代表桶／IAM／媒体已安装，真实资产、CDN、区域测速和新小图生成继续由对应媒体流程完成。

## 同次完整采集与接续

publish 先持有 canonical 锁并建立经过验证的数据库连接，再调用原完整 worker。源端 HTTP 之前，固定 writer 校验自动学习能力及当前实际政策。只进行一次完整采集，同次保留 records／学习排序／全部媒体／目录 metadata 与 deny。原件上传后独立回读并验证字节；准备工件完整落盘后才 SQL stage／promote，随后独立 reader 核对接受状态并封存 `incremental-baseline.json`。

已有 prepared 或 accepted 文件时 publish 在数据库／来源分配前拒绝。发布响应丢失或封存中断，改用 **seal**：只读同一准备工件和独立数据库成员／状态，没有来源、下载、上传或再次 promote。未接受批次、scope／policy／成员变化和损坏文件拒绝封存；不把响应丢失当作已经失败或再次发布的理由。

封存之后用 [增量入口](INCREMENTAL_HOST.md)的 initialize 消费该文件。它仍核对完整 raw 内容与媒体描述、共用学习证明、安装两份缓存和目录 seed；accepted 文件存在不等于对象覆盖或网站切换已经验收。正常日常周期不再完整采集。

## 预算与回执

首次 publish 默认 60 分钟、5,000 次来源 HTTP 尝试、256 MiB 来源响应和 8 GiB 媒体传输预留；绝对上限 90 分钟、20,000 次、2 GiB 来源响应与 16 GiB 媒体预留。独立原件集合 `--max-media-bytes` 默认 1 GiB、最多 2 GiB。可显式调整 `--duration-ms`／`--source-requests`／`--source-bytes`／`--media-bytes`，均在锁和网络分配前检查。seal 默认 120 秒。日常增量的 120 秒／400 次／32 MiB／64 MiB 默认与原上限保持。

来源和图片实际收到的字节全部计费，包括失败尝试。每次 immutable put 为上传及可能的已有对象核验预留两份字节，随后另预留一份独立回读；保守预留不退款。租约续期回复不确定时立即取消正在进行的来源请求，不能继续付出完整采集成本。取消停止新 HTTP，SQL 连接收尾后才释放锁，不在清理时确认未知提交。

私有 `baseline-latest.json` 只保存固定结构的阶段、计数、预算及布尔状态；stdout 同样只输出聚合，不包含 runId、scope、路径、凭据或正文。status 无连接，拒绝未知额外字段；help 无 I/O。accepted 返回 0，failed／unconfirmed 返回 1，cancelled 返回 2。该回执描述最后一次命令；查看上一份已接受工件的资格仍用 seal 和 initialize。

本机组合使用模拟 Notion HTTP／对象端口、真实 PGlite 权限与 SQL、三个实际 SQLite，不能当作云 TCP／TLS、真实来源、COS 或线上独立图片验收。实际角色／能力、首次完整采集、媒体覆盖、单次增量与中断恢复、隔离 Notion 的访客访问，以及最终切换仍须留真实回执。
