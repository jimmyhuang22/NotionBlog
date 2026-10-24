# Mac mini 增量运行入口

入口为 `node scripts/website-incremental-sync/cli.ts`，需要 Node 24。它消费现有队列、学习领域、普通内容缓存、独立 reader／writer、完整基线及目录发现模块。没有修改现有 Dagu、安装程序、周期、默认网站模式或云配置；首次完整采集工件的生成和实际切换仍由安装阶段完成。

## 显式启动

`initialize`、`recover`、`run` 都要求显式 `--config`、`--lock-dir`、`--runtime-dir` 绝对路径。来源 JSON 必须为当前有效的私有 600 文件；运行目录为私有 700 目录，存储 queue、study、content 三个独立 SQLite 及两份私有状态。`--lock-dir` 必须填写旧发布器实际共用的 canonical 状态目录，不能为新程序另取一个锁目录。程序使用现有 `worker.lock`，不抢锁、不自动解锁旧队列租约。`status --runtime-dir ...` 仅查看经过结构校验的聚合回执；`--help` 不建立连接。

必需环境为 `SYNC_PUBLICATION_MODE=published`、`SYNC_MEDIA_PROVIDER=storage`、`SYNC_READER_DATABASE_URL`、`SYNC_DATABASE_URL`。连接必须是分别继承受限 `nb_delta_reader`／`nb_writer` 的实际 LOGIN，目标／租户／scope 一致，TLS 沿用显式验证配置；没有网站 URI、admin 或缺省凭据回退。适用配置必须包含自动课程和笔记来源，旧逐页试读配置不会被自动扩大。

仅 `run` 在恢复成功后需要 `NOTION_TOKEN` 和独立 storage 配置。现有 Supabase 适配仍要求专用 Storage writer JWT；本机适配仅允许 loopback 数据库。可继续显式配置现有图片 cache／originals 和 HEIC converter。COS 接入、实际原件和小图覆盖、CDN／浏览器缓存仍单独验收，本入口没有代替这些步骤。

## 首次初始化与中断

`initialize ... --artifact /absolute/private/baseline.json` 消费同一次已接受完整发布的私有工件：`format=incremental-baseline-v1`、真实完整发布 `fullRunId`、独立读回的 `state`、`collectWebsiteStudyBaseline` 的 `collection`、该次全部 `media` 描述、`deniedPageIds` 和同次 `captureDirectoryMetadata(...).seal(records)` 得到的 `directory`。该文件为 600、最多 48 MiB；不得从旧运行计数、公开 DTO、旧单课快照或再爬一次的来源拼造。

入口独立回读完整内容／媒体集合及正文证明，首次两个缓存都缺失时共用这一次实际完整读回，再验证学习排序 companion，不重复读取学习正文。中断重试时已有同版本缓存必须与完整输入逐项匹配，并重新完成独立完整证明，缺失的那份单独安装，不改版本字符串或覆盖原内容。最后确认全局状态未变，事务保存目录种子，再持久写 `incremental-ready.json`。任一步失败均不能进入发现；取消和中断可用原工件重试。目录种子不清 pending／unknown，不制造水位；首次仍扫描元数据，既有未变正文不会全部重新排队。正常周期不重复基线证明或来源全量采集。

## 恢复与单周期

`recover` 不构造任何 Notion、下载或对象 storage 端口。`run` 同样先执行这一阶段：旧提交仅 lookup → 独立 reader 验证 → 学习及普通缓存安装 → 队列确认；缺回执继续 blocked，不重采、不重发。失效的“准备中”租约只能由队列自身产生真实 never-submitted closure，再退休两份 staged 数据。恢复端口从不代理真实 prepare，最多给一个新领取任务留下立即可重试的本地 terminal 记录。未到期租约、未确认提交或未完成退休均阻断新来源请求。

恢复完成后核对 SQL、两个缓存和原 policy epoch，再创建实际 SDK 来源。直接来源用分页 changes／membership；已知普通页和深层笔记轮巡自己的元数据；学习物理子目录轮巡不依赖父页时间戳变化。来源轮流接续，每轮默认最多三个来源、每来源两步目录扫描，学习最多五个父节点；未知可用性只触发复核，不当成删除。新增普通页位置来自实际完整元数据目录。

执行阶段使用原协调层和双缓存包装：所有准备在提交标记之前持久 stage，两个领域 finalize 完成后才确认队列。新图沿用原安全下载／强验证器 cache，实际验证 SHA、MIME、尺寸及独立存储字节；原件保持不可变，已有匹配描述不重新上传，不生成或重压既有小图。缺图、坏字节和存储失败不能指回 Notion 作为成功结果。

总周期默认 120 秒、20 项任务、400 个实际来源 HTTP 尝试、32 MiB 来源响应、64 MiB 图片预算；`initialize` 默认上限 899 秒。`--duration-ms`、`--max-tasks`、`--max-sources`、`--source-requests`、`--source-bytes`、`--media-bytes` 可显式缩放，但必须满足代码上限。图片收到的每块字节、失败尝试，以及对象读写的完整预留均计费，不退款；旧 SDK 调度／Retry-After 保留，每次尝试受相同取消和预算约束。SIGINT／SIGTERM 停止新请求；SQL 连接关闭后才释放 canonical 锁，清理不会补确认未知工作。

每轮只写聚合 `incremental-latest.json`，没有凭据、Source ID、URL、正文或运行版本身份。正常有界 `partial` 返回 0，保留待处理任务；retry／blocked／needs_review／failed 返回 1，取消返回 2。CLI 不安装新计划，不替 Dashboard 作自动恢复判断，也不定义真实更新时效；实际周期、角色／TLS、首次完整工件、原件／变体覆盖及断 Notion 整站验收是后续安装的条件。
