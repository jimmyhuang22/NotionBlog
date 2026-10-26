# 开发接手说明

最后更新：2026-10-13（2026-10-26 修正仓库与检查现状）。后续开发集中到 Mac mini；GitHub 仓库保存公共源码、测试与文档（干净新仓库 2026-10-23 起公开），设备私有背景和输入单独迁移。当前事实与读法先看[入口说明](START_HERE.md)；本文件是新开发环境的入口；当前上线与重构接线顺序先读 [重构上线准备](REFACTOR_ROLLOUT.md)。

## 开始顺序

先读 `AGENTS.md`、`README.md`、`docs/REQUIREMENTS.md`、`docs/decisions/` 与 `docs/progress/` 下的记录，以及存档 `docs/DECISIONS.md`、`docs/PROGRESS.md`；若存在，继续读 `.local/DEVELOPMENT_TRANSFER.md` 和 `.local/PROJECT_MEMORY.md`。进度记录是历史记录，新状态按最新交接及实际证据核对，不把旧的“未配置”当作当前阻塞。

在目标工程目录先检查本地改动、当前分支和远端。已有 worker 分支可能与主线分叉，不能用旧补丁覆盖新代码。保存本机未推送提交与改动后再合并，冲突保留双方已完成工作。

遵守最新 `AGENTS.md` 的分支约定：`develop` 是日常集成分支，`main` 是线上分支。每项工作从最新 develop 建短期分支，提交与合并请求使用英文；按改动影响完成本机验证、无冲突、PR 正文写明受检提交／验证方式／限制并核对实际差异后自行合并 develop，不等待平台 CI。当前 Mac mini 运行器已退役，私人 PR 的平台应用检查跳过，`SKIPPED` 不算通过，没有两小时集中检查；恢复另行约定，已知代码、协议或构建失败仍须先解决，详见[本机验证合并决定](decisions/2026-10-22-develop-merge-local-verification.md)。不为无关 develop 更新反复同步与重跑；冲突、同一逻辑或依赖／契约／配置／迁移／检查环境变化时先整合验证。纯说明／记录文档做记录格式、相关链接、差异和隐私检查，应用或构建输入改变集中 check／build。发布到 main 仍检查当前完整集成版本并通过平台 CI，只由用户合并或按单次明确委托执行。

合入 develop 前先核对是否有打开的 develop → main 发布请求。有的话暂缓合入，继续在独立工作分支开发、验证和推送；等发布合并后恢复，避免发布检查因 develop 的新变化重排。用户另行明确解除暂停时按其指令执行，见 [发布窗口决定](decisions/2026-10-13-develop-hold-during-release.md)。

```sh
git status --short
git branch --show-current
git remote -v
git fetch origin
git log --oneline --left-right HEAD...origin/develop
# 本地干净且可以快进时：
git merge --ff-only origin/develop
```

不能快进时先核对分叉内容并保留本机历史，完成普通合并和验证；不为拉取主线清除工作目录或丢弃私人文件。整合后的主线已包含原 worker 和来源范围修正，已有相同修正不重复应用历史交接补丁。

Node 24 为推荐基线，根工程支持 >=24 <27。安装锁定依赖，再做检查：

```sh
npm ci
npm ci --prefix scripts/game-sync --ignore-scripts
git config core.hooksPath .githooks
npm run check
```

Vercel 的 `vercel.json` 同样安装根工程和游戏模块独立依赖。Next.js 的类型检查覆盖这些 CLI 源码；仅运行根目录 `npm ci` 会缺少 `psn-api`。此配置只调整安装步骤，游戏程序仍单独运行。

提交作者与邮箱由用户指定，仅在当前仓库配置；具体值见私有接手说明。不要复制另一台设备的 `node_modules`、`.next`、`.git`、认证缓存或工具配置来代替安装／登录。代码从 GitHub 获取；已有本地历史单独保留。

## 当前实现与下一项

| 部分 | 已完成 | 待完成 |
| --- | --- | --- |
| 网站前端 | 首页、作品库、动态、层级学习阅读与关于弹层；年份筛选、正文渲染和社交合集卡片；正式首页社交翻页及桌面／手机验收 | 全部课程真实目录／阅读导航、新媒体模式、剩余封面场景及地区网络 |
| 内容服务 | mock／notion／database、统一 DTO／AST、网站 v2、自动学习扩展、持久发布与独立图片读取 | 真实完整基线、published/storage 模式切换及断 Notion 访问 |
| 数据库 | 受限角色、原子发布、增量提交／独立 reader、中央撤回、备份恢复扩展 | 新扩展实际安装、真实 LOGIN／TLS 与托管恢复；代码合并不安装云能力 |
| 内容同步 | 既有 v2 完整同步与小图接续已运行；增量 host/CLI、队列、双缓存、目录发现、恢复和同次完整工件 producer 已合入 develop | 可执行首次发布／恢复接线、真实完整工件、新运行包安装、真实增量与故障恢复、调度切换 |
| 游戏账户模块 | 独立 Steam／PSN／Nintendo → Notion CLI；正式增量计划、写后复核及失败回执；Steam 已获准以固定允许／排除名单加入每日任务 | 首个日历回执与登录续期；固定名单变化及新增版本核查，未选择固定模式的环境仍需人工隐私核验 |
| 社交采集 | 独立 SQLite/outbox、受限云接入、有界周期与 Mac 启动器；retained 正式展示与采样标签已验收 | 自然刷新监测，按既定审核规则接纳新作品／成员 |
| 媒体与运行 | 既有原件与小图可复用；正式站真实读库，网站／游戏调度由 Dagu 管理 | 新独立原件／变体覆盖、切换回滚与国内／海外网络；不重复下载或重压已有资产 |

正式站已读真实数据库，仍使用 qualified 内容批次和混合图片；社交已显式启用 retained 展示。已授权全部课程与自动拥有后代，不等于当前运行来源和线上批次已完成扩大。搬迁、Git 合并与安装代码均不自动改变公开范围或运行模式。

## 同步程序与当前运行

`scripts/notion-sync/` 保留冻结 v1；当前网站完整 v2 同步在 `scripts/website-sync/`，新的 `scripts/website-incremental-sync/` 提供 initialize/recover/run/status，尚未替换旧运行入口。`scripts/game-sync/` 从游戏平台读取账户数据，再用独立 Notion writer 维护平台记录；`scripts/social-sync/` 独立采样并上传已审核作品投影。网站 reader、Notion 只读 Token、游戏 writer、内容 writer 和社交身份用途独立。

内容 worker 的固定协议与验证命令：

```sh
npm run database:protocol
node scripts/notion-sync/cli.ts --help
# 使用目标设备的规范绝对路径；这里仅运行虚构 demo：
node scripts/notion-sync/cli.ts --demo --mode dry-run --state-dir "$SYNC_PRIVATE/offline-state"
```

同步 v1 与核心 SQL 已冻结；Status reader 是独立扩展。移机无需另建表、重新签发全部身份或重放已完成的账户整理。匹配安装政策与 configDigest，不能截断采集却宣称 complete。

## 私有配置迁移

| 输入 | 目标用途 | 交接方式 |
| --- | --- | --- |
| `.local/PROJECT_MEMORY.md` 与最新接手记录 | 用户要求、真实来源背景、云配置与历史证据 | 私有上下文包，保持忽略 |
| `config/site.json`／真实来源 JSON | 本地个人信息、映射和当前允许名单 | 私有上下文或既有配置包；有冲突先核对，不覆盖目标设备的新值 |
| 项目 `.env.local` | 本地网页运行 | 在目标设备按模板和已转交凭据合并；修正旧设备绝对路径，保留现有环境 |
| 内容 worker 私有输入 | Notion 只读 Token、受限数据库连接、TLS CA、Storage 会话及续期工具 | 既有独立凭据包；只在私有运行目录使用 |
| 游戏同步私有输入 | 独立 Notion writer、账户登录、身份、绑定与排除规则 | 独立游戏凭据包＋目标设备已有账户输入；登录状态需要本人核验 |

私有目录 700、文件 600，环境值不放进命令行、Git、公共文档或客户端。保留目标设备的最新会话与配置；一次性刷新令牌由唯一执行端维护，迁移后的旧设备不同时刷新或运行同一 writer。个人 blocklist 需在目标设备保留／补齐，不把含真实密钥的 blocklist 当作普通文档发布。

已有私有手动包装器可合并两份 env、刷新 writer 会话，并限制 dry-run／stage；具体路径和用法见随私有输入交付的 runbook。不要把历史凭据 ZIP 当作当前会话状态来覆盖已旋转的文件。

开发检出与长期运行 release 分开。开发工程可以使用开发盘，运行配置／状态需位于有可靠所有权与权限的私有目录；正式 worker 使用独立不可变 release 和唯一调度入口。先完成手动验收，再落实周期、资格 TTL、续期、告警和备份；搬迁本身不授权加载 launchd 或切换云端 provider。

## 推荐接手任务

1. 核对 main、develop、实际运行 release 和私有回执，按锁文件安装；确认正式运行端唯一。按 [上线准备](REFACTOR_ROLLOUT.md)区分已合代码、已安装能力和线上模式。
2. 内容历史完整strict／stage已验收，后续 v2 实际发布及单课目录／小图已有回执。沿用现有证据和对象，不因为接手再次重采全库；新持久模式需要同一次获准完整采集的真实工件，旧单课快照不能替代。由原拥有方完成工件生成和独立确认后再初始化。
3. 游戏手动同步和本轮资料整理已验收，先读 [Notion 维护交接](NOTION_MAINTENANCE.md)。后续仅处理新增资料和实际变化，正式 CLI 已具备增量、精确计划与写后回读；用户后续明确用固定允许／排除名单将 Steam 加入 PSN／Nintendo 每日任务。使用固定 release 与同一目录锁，查看私有每日回执和本机失败提醒。沿用更新的私有输入，不重复建库或旧数据迁移；在 Steam 更改隐藏／私人标记时须同时更新固定名单，未启用该模式时原人工证据仍会过期。
4. 核对新增 reader/writer LOGIN、TLS 和全部能力；按 initialize → recover → 有界 run 的顺序验收增量、撤回与故障恢复。复用已有原件／小图，完成独立图片和阻断 Notion 的代表链路验收，再切换运行和网站模式。
5. 前端继续消费统一入口，真实基线交回全部课程页数、最长目录、最大层级及代表页；Claude 验收目录顺序、上一篇／下一篇和媒体。社交已完成正式验收，后续观察原自然周期，不重复部署或扩大清单。

接口和操作细节分别见 [数据库同步协议](DATABASE_SYNC_PROTOCOL.md)、[内容 worker](NOTION_SYNC_WORKER.md)、[游戏同步](GAME_ACCOUNT_SYNC.md)、[作品字段](MEDIA_LIBRARY_SCHEMA.md)、[前端接手说明](FRONTEND_GUIDE.md)、[前端对后端的需求](BACKEND_HANDOFF.md)、[隐私约定](PRIVACY.md)。此入口在需求／部署／交接状态改变时持续更新。

## 自动检查与分支部署

`.github/workflows/check.yml` 保留 main／develop PR 与手动入口，没有 push 或 schedule，也不复用旧树缓存。仓库公开后，合并请求的检查在标准托管 Ubuntu 上运行：Node 24、安装上述两份锁文件，运行 `npm run check` 和 `npm run build`，另有隐私历史检查（2026-10-26 核对，最近的合并请求均已通过），见[运行说明](GITHUB_ACTIONS_RUNNER.md)。专用 Mac mini 运行器已退役。日常 develop 按影响完成本机验证后合并，不等平台检查；main 发布须完整检查通过。只有仓库只读权限，不读取私人环境或部署 Token；Actions 固定官方提交，checkout 不保留凭据。

`vercel.json` 的自动 Git 部署只允许 main，develop 和工作分支不生成新预览；日常合并依赖按影响的本机验证，平台检查恢复另行约定。集中积累改动后再开 develop → main 的发布请求，由用户合并。旧工作分支需要先整合最新 develop 才取得此配置；历史 Preview 保持旧代码。Git 配置不控制手动部署、重新部署或部署钩子，只有用户明确要求时才执行；内容同步和刷新页面不需要部署。配置依据见 [Vercel Git 配置](https://vercel.com/docs/project-configuration/git-configuration)。
