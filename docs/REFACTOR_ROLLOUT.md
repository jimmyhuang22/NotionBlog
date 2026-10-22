# 重构上线准备

状态核对：2026-10-13，Australia/Melbourne。本文件汇总当前实现与运行差异，以及下一次切换所需的证据；后续状态变化同时看 [逐项进度](progress/README.md)和执行端私有回执。历史设计中的“待实现”不能代替最新模块记录，代码存在也不能代替实际安装和验收。

## 当前状态

目标是 Notion 编辑 → Mac mini 发现和同步变化 → PostgreSQL 已发布内容与独立对象 → 现有网站。网页与图片最终都不访问 Notion；前端 DTO、AST 和统一内容入口保持。

| 层 | 已交付 | 当前运行与剩余工作 |
| --- | --- | --- |
| 正式网站 | 真实 v2 读库；社交卡片、采样时间、合集和首页翻页已上线验收 | 内容仍 qualified，普通图片仍混合动态来源；新模式未切换 |
| 持久发布和数据库 | 独立指针、原子差量、独立 reader、撤回与备份恢复扩展；五项新云扩展已安装 | 安装与受限连接校验通过，原政策／批次保持；新指针尚未激活，托管恢复仍待 |
| 来源与缓存 | 变化队列、深层轮巡、物理子页发现、普通内容缓存、学习检查点和目录种子 | 真实完整基线和实际变化／撤回需要联调 |
| 主运行器 | PR204 已合入 develop；initialize/recover/run/status 及本机恢复组合通过 | 尚未安装到既有 operating release；主入口不生成首次完整工件 |
| 首次完整工件 | PR208 producer 与 PR213 首次发布／无来源恢复入口；首次与增量 CLI 已接入长采集会话及锁内资源清理 | 候选包待包含最新接线，尚未安装／实际 full → seal → initialize／真实会话续期 |
| 媒体 | 独立原件和按 SHA 读取 400/800 小图的代码；既有原件／小图可复用 | 完整覆盖、独立实际传输、断 Notion 与地区性能尚待 |
| 学习 | 自动课程与实际拥有后代的工程、排序和前端适配 | 当前运行仍旧允许名单；单课目录已重发，全部课程尚未实际验收 |

正式社交版本由发布 PR202 进入 main；同提交的 PR205 已被包含，没有第二次发布。后续 PR215 已获用户单次授权发布并复验，主要网站改动是作品库列表信息行；主运行器与 producer 代码也随该发布进入 main，但首次发布入口 PR213 在其后才合入 develop。两次发布均没有启用内容持久模式、增量任务或新媒体 provider。网站 main、develop 与 Mac operating release 需分别核对；后端脚本进入 main 不会自动替换 Mac 运行包。

证据入口：[主运行器](INCREMENTAL_HOST.md)、[首次完整工件](FULL_BASELINE_ARTIFACT.md)、[首次发布入口](FULL_BASELINE_HOST.md)、[writer 会话适配](WRITER_STORAGE_SESSION.md)、[持久发布](CONTENT_PUBLICATION.md)、[增量连接](INCREMENTAL_DATABASE_BINDING.md)、[独立小图](PUBLISHED_THUMBNAILS.md)、[学习共用基线](STUDY_SHARED_BASELINE.md)、[目录种子](WEBSITE_DISCOVERY_BASELINE.md)、[社交联合验收](progress/2026-10-13-social-integrated-acceptance.md)。

## 本次实际准备检查

只读检查了当前私有运行配置、来源模式、manifest、凭据是否存在和文件权限；用 manifest 指定的 Node 24 执行原固定入口的 `--check`。结果：旧 release 完整性检查通过，来源摘要匹配，现有 reader/writer 输入可用；运行模式仍 qualified/notion，旧 release 不包含新增量 CLI，课程与学习来源仍为 allowlist，未在当前 operating state 找到 incremental-ready。

现有 reader 使用原固定入口的独立文件；新 CLI 要求显式 `SYNC_READER_DATABASE_URL`，不能把没有这个新变量解释为 reader 账号不存在。需要在新私有环境中映射并核对已有身份，不重新索取全部凭据。

续办已准备自动学习配置；学习拥有方进一步补齐已决定的“排序”字段映射，已审最终候选取代最初未含该字段的候选。来源键与全部非学习来源保持；解析器与 producer 范围守卫通过，最终文件与摘要在执行端私有目录，尚未安装。policy／full／seal／initialize 必须消费同一最终摘要。此检查不证明真实全部后代或媒体已符合新范围，也不是已接受 baseline。

首轮离线准备没有连接云库或来源。续办对端口匹配后的 reader 做了两次顺序短连接：read-only 事务仅查询角色／当前连接元数据，另一连接不执行 SQL，实际客户端 TLS 1.3 和证书授权通过。共四条 SQL 命令，不证明当时尚未安装的新 API、完整 scope 或首次基线。没有读取图片、刷新会话、占发布锁、初始化实际缓存、安装运行包、修改 Dagu 或部署。

安装拥有方随后于 2026-10-13 04:03 UTC 交回五项云扩展的实际安装与受限连接回执：能力／摘要、独立 LOGIN／TLS 校验通过，原政策、允许／撤回名单与发布批次未变，新持久指针保持未激活。本方沿用其回执，没有重复云查询或安装。现有 Storage JWT 不能覆盖首次长采集；续期适配已接入两个 CLI，固定 token 的窗口不足时先于来源读取拒绝，迟到 factory 与轮换清理在释放锁前完成。接线以虚构输入验证，真实会话证明仍由运行拥有方交回。文件存在性或本机测试不证明媒体覆盖；详细报告留执行端，不提交路径、来源 ID、连接串和正文。

当前已选择在现有项目安排维护切换。先备齐运行包、独立媒体、会话、预算和回退步骤，最后才进入明确窗口并更改政策；新政策会使旧 qualified 快照失效，恢复旧政策不能复活旧批次。此选择不代表已经开始维护或已执行首次发布。旧自然轮次最近因临时封面地址到期失败，原拥有方正在修复与安排恢复；切换前须协调其任务和后续小图步骤的退出状态。人工图片清理与社交优化不是等待整个重构上线的条件。

## 接手与切换顺序

1. **冻结代码与运行基线。** 核对 producer 和 host 的最终合并提交；用锁文件准备不可变 release，记录文件／Node 摘要。保留旧 release、私有配置、当前发布及锁路径。系统 Node 版本可能不同，固定入口须使用 manifest 指定的 Node，不能用普通 `node` 替代后忽略 RELEASE_INVALID。
2. **安装及核对云能力。** 由 migration owner 按各协议安装匹配的网站 v2、自动学习、持久发布、增量提交／reader 及需用的小图扩展，记录实际摘要。安装不激活发布。reader/writer 是独立受限 LOGIN、同一目标及 scope、验证 TLS；继承角色不改为 LOGIN，不用管理员或网站连接顶替。完整接受基线建立后再用现成 [只读预检](INCREMENTAL_DATABASE_BINDING.md#只读运行前检查)确认可运行。
3. **准备私有配置与媒体。** 按已有全部课程授权配置自动课程及物理拥有后代，保留 deny、既有来源与个人字段。新环境显式选择 published/storage 和独立 reader/writer；复用已有 cache/originals 和真实对象，只处理缺失／变化资产。COS/CDN 接入仍由媒体拥有方落实，备份和压缩候选不等于生产对象已就绪。
4. **一次完整采集制作工件。** 在同一 canonical 锁和获准完整 publisher 内接入 [producer hook](FULL_BASELINE_ARTIFACT.md)，同次保存 collection、全部 media、学习 companion、deny 和目录元数据。每次完整运行使用独立的私有工件目录，准备与接受文件不可覆盖；失败后保留目录，用相同输入核对续办。准备文件保存成功后才 SQL stage/promote；独立 reader 确认实际接受状态后封存七字段 baseline。旧单课快照、公开 DTO、自填 receipt 或第二轮爬取不能替代。
5. **初始化及恢复。** 用已接受工件执行 initialize：首次双缓存共用一次完整 raw-reader 证明；只缺一份时核对已有、补缺失，目录 seed 和 ready 最后完成。发布响应丢失先 lookup／seal，不能重跑完整采集；增量 unknown 提交先 recover，经独立确认、双缓存 finalize、queue ack 后再发现新变化。
6. **有界真实联调。** 按下表完成一轮代表场景，记录实际 HTTP／SQL／字节／时长与版本，沿用同版已有测试，不重复整库或全图验证。确保旧 publisher 与新 host 使用同一 worker.lock；交接写窗口时停旧调度的新触发并等在途退出，不删除锁或并行启动两套 writer。
7. **安装调度并切换网站。** 周期、更新与撤回目标、监测和回滚窗口具体落实后，由运行拥有方安装；网站匹配 `CONTENT_PROVIDER=database`、`DATABASE_CONTENT_VERSION=2`、`DATABASE_PUBLICATION_MODE=published`、`MEDIA_PROVIDER=storage`，需要小图时显式 `MEDIA_THUMBNAILS=enabled`。正式变更按既有发布授权执行，安装代码、合并 develop 或内容同步不需要额外部署网站。

### 主运行器命令模板

以下变量由安装拥有方从当前私有配置填写，全部路径必须为绝对路径；不要直接复制历史设备路径。`NB_CANONICAL_STATE` 是旧固定入口实际 config.stateDir，不能误填整个私人根目录或新建第二个锁目录；`NB_INCREMENTAL_STATE` 与它分开。

```sh
"$NB_NODE" "$NB_RELEASE/scripts/website-incremental-sync/cli.ts" --help
"$NB_NODE" --env-file="$NB_INCREMENTAL_ENV" \
  "$NB_RELEASE/scripts/website-incremental-sync/cli.ts" initialize \
  --config "$NB_SOURCE_CONFIG" --lock-dir "$NB_CANONICAL_STATE" \
  --runtime-dir "$NB_INCREMENTAL_STATE" --artifact "$NB_BASELINE_ARTIFACT"
"$NB_NODE" --env-file="$NB_INCREMENTAL_ENV" \
  "$NB_RELEASE/scripts/website-incremental-sync/cli.ts" recover \
  --config "$NB_SOURCE_CONFIG" --lock-dir "$NB_CANONICAL_STATE" \
  --runtime-dir "$NB_INCREMENTAL_STATE"
"$NB_NODE" --env-file="$NB_INCREMENTAL_ENV" \
  "$NB_RELEASE/scripts/website-incremental-sync/cli.ts" run \
  --config "$NB_SOURCE_CONFIG" --lock-dir "$NB_CANONICAL_STATE" \
  --runtime-dir "$NB_INCREMENTAL_STATE" --duration-ms 120000 --max-tasks 20 \
  --max-sources 3 --source-requests 400 --source-bytes 33554432 --media-bytes 67108864
"$NB_NODE" "$NB_RELEASE/scripts/website-incremental-sync/cli.ts" status \
  --runtime-dir "$NB_INCREMENTAL_STATE"
```

只有 help 和 status 不建立云连接。initialize/recover 会读云库并改变本机状态，run 还会读取来源和提交变化；这些命令没有 dry-run，模板不是已经执行的回执。status 的 uninitialized 表示未找到聚合报告，不证明可以切换。完整环境和退出码见 [主入口说明](INCREMENTAL_HOST.md)。

## 一轮真实验收与交回证据

| 场景 | 必须观察到的行为 |
| --- | --- |
| 同次 baseline 与首次启动 | 实际接受 fullRunId/revision、scope/schema/policy 一致；完整 raw/media 回读后两个缓存和目录 ready |
| 无变化、新增与编辑 | 未变正文／媒体复用；只准备变化与必要依赖；新增普通记录及父时间戳未变的深层子页可发现 |
| 撤回与异常 | 明确删除／移出／祖先 deny 阻断内容、链接和媒体；连接失败不冒充删除；记录发现到阻断的实际时间 |
| 中断和丢响应 | 原 operationId/digest lookup、独立确认、两个缓存完成后 ack；未确认状态不重采、不重发、不偷未到期租约 |
| 独立访问 | 隔离访客服务的 Notion 网络，代表列表、学习正文、内链、400/800 和原图可读；源调用为零，不能回退 Notion |
| 学习和前端 | 交回课程数、每课页数、最长目录、最大层级和代表页；Claude 核对顺序、上一／下一篇及桌面／手机 |
| 媒体与网络 | 原件／变体实际摘要、尺寸、字节及覆盖；区分本机协议与云 TCP/TLS，国内／海外页面/API/媒体另有实网结果 |

回执聚合复用／新建数量、失败和待处理项、预算、恢复结果、实际范围与切换状态。unknown、权限漂移、缺媒体、scope/policy 变化或无法证明独立访问时保持旧运行，不以测试数量代替真实验收。

## 回滚与分工

先保存旧 release、来源／环境摘要、运行入口和新鲜 qualified 批次；只切网站配置而旧 qualified 已过期，不能保证恢复访问。回滚时停止新触发、等待在途操作退出，核对 unknown 提交后再恢复旧唯一 writer 和配置；保留新指针、云历史、原件／小图、queue 和两个缓存，不自动删除或恢复旧备份为公开。具体网站发布回滚由原发布拥有方处理。

主运行器与安装：查找预览图功能进度；首次工件与学习：与Claude对接；现有 v2 发布及自然小图接续：后端交接；来源／队列／普通缓存：Notion数据库维护；文件资产与存储交付：图片处理；社交自然刷新：规划社交视频时间线；前端真实页面：Claude。本次文档与离线预检由查看重构进度负责，不接管上述运行窗口。
