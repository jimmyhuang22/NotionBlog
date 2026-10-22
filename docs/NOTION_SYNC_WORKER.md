# Notion 同步 worker 操作与交接

混合图片试验使用 `SYNC_MEDIA_PROVIDER=notion`：继续下载与验签，普通图不上传 Storage，转换图继续上传，并在同一批次登记定位。默认 `storage` 保留原行为，启用条件及计数含义见 [混合媒体说明](HYBRID_MEDIA.md)。

阶段：单次 CLI、离线采集、冻结SQL联调及Mac mini完整真实strict／stage已验收；网站reader／媒体、发布与实际备份恢复仍需分别验收。入口在 `scripts/notion-sync/`，Node 24 原生执行 TypeScript；没有额外依赖、数据库迁移、网页入口或自动调度。原交付基线为 `65ab46fd85f19afee614cdca7e0b963752673500`，协议与schema摘要直接导入 `contracts/sync.ts`。

原交付验证：Node24类型、协议摘要、全仓库217项测试与隐私检查通过（含新增50项 worker 测试）。离线CLI三种模式均实际退出0，129条记录／1个67字节图片／141次虚构HTTP请求，采样RSS约114–115MiB；这只是小虚构样本，不能用45–49ms转换用时估算真实网络耗时。运行预算预留512MiB–1GiB，真实采集后再校准；没有本地数据库或常驻HTTP端口。新增代码仅是CLI，没有更改app服务端／依赖／SQL，因此原交付不以生产构建结果作为CLI验收，沿用全仓库类型、协议、测试和隐私检查。

整合复验（2026-10-11）：上述为 Mac mini 原交付记录。本机在包含 Status 读取扩展的 `860acbb` 基线上导入相同 worker 代码，Node24.20.0 下233项测试、类型、核心／reader摘要、隐私及plist检查通过；Webpack生产构建与19份私人文件追踪排除通过。三种离线CLI复跑仍为129条记录／1张图片，锁释放且未写真实成功checkpoint。同步 v1 与 schemaDigest 保持一致，Status列表派生字段不影响详情采集。真实云端接入仍待单独验收。

私有输入准备后的修正：Status 与课程按精确来源及允许页面校验，不要求读取来源外层容器；学习来源仍验证它所在课程和全部祖先。补充未授权外层容器的回归后，234项全仓库测试、类型、双摘要与隐私检查通过。配套私有配置、云端权限与 JWT 续期验证回执保存在忽略目录；这些验证尚不代表 Mac mini 完整真实采集、网站读库与备份恢复已验收。

开发交接整合（2026-10-11）：保留执行端已完成的HEIC、有界下载、连接复用、MIME规范化与祖先完整样本修正；271项测试、类型、双摘要、隐私、生产构建和19份私人追踪排除通过。外部图床的间歇故障及旧URI空白已按用户授权在原Notion页面修复托管，原图字节及页面内容差异证据留主机私有目录。完整strict／stage通过：297内容／246媒体引用／245对象，约388MB；全部对象回读、81处修复原图核对、3张HEIC转换、来源集合、学习层级及云端完整性验收通过。strict约10.7分钟、stage约22.6分钟；12页合法partial，仅为不支持的嵌套内容、块类型及受限链接。准确计数和父进程RSS见PROGRESS；没有发布、推进checkpoint、启用调度或切换网站provider。

## 目录与启动

开发使用独立 worker worktree；正式运行使用 Homelab 内盘 `Services/notionblog-sync/{releases,current,shared}`，不能直接运行开发目录。环境、状态和来源配置用内盘私有根，避免外接开发盘忽略所有权时的凭据权限问题。实际主机路径与 Node 版本写入主机 runbook，不写个人路径进本仓库。

锁文件在同一个 `SYNC_STATE_DIR`，手动与未来 launchd 必须使用同一目录。私有目录700、文件600，路径要求绝对且规范；不接受状态目录或凭据文件的符号链接。不依赖网站 `.env.local`，不覆盖它。

在项目根，先设置指向本机实际路径的 `NODE24`、`WORKTREE` 和 `SYNC_PRIVATE`。入口显式指定解释器和状态路径：

```sh
"$NODE24" "$WORKTREE/scripts/notion-sync/cli.ts" --help
"$NODE24" "$WORKTREE/scripts/notion-sync/cli.ts" --demo --mode dry-run --reconcile --state-dir "$SYNC_PRIVATE/offline-state"
"$NODE24" "$WORKTREE/scripts/notion-sync/cli.ts" --demo --mode stage --state-dir "$SYNC_PRIVATE/offline-state"
"$NODE24" "$WORKTREE/scripts/notion-sync/cli.ts" --demo --mode publish --state-dir "$SYNC_PRIVATE/offline-state"
```

`--demo` 使用125条虚构动态、课程／周／子／孙页面、110块正文及虚构图片，Notion HTTP 也完全由本地 transport 模拟。stage／publish 只写内存，没有云写入或真实成功 checkpoint。单次退出后内存对象即消失；磁盘只保留匿名报告。

私有配置模板：`scripts/notion-sync/templates/sync.env.example`。复制到内盘受保护文件，由用户填写已有只读 Token 与当前允许名单，不重新创建连接或扩大权限。两个来源输入 `NOTION_SOURCES_CONFIG`（绝对文件路径）和 `NOTION_SOURCES_JSON` 二选一。数据库使用仅授予 nb_writer 的 LOGIN；Storage 使用 publishable／anon API key 加独立 authenticated writer JWT，拒绝 broad service_role／secret。身份续期由后端安全配置流程提供。

```sh
"$NODE24" "$WORKTREE/scripts/notion-sync/cli.ts" --env "$SYNC_PRIVATE/sync.env" --state-dir "$SYNC_PRIVATE/state" --mode dry-run --reconcile
"$NODE24" "$WORKTREE/scripts/notion-sync/cli.ts" --env "$SYNC_PRIVATE/sync.env" --state-dir "$SYNC_PRIVATE/state" --mode stage
# 仅在真实 staging、策略与时效已验收后由操作者显式执行：
"$NODE24" "$WORKTREE/scripts/notion-sync/cli.ts" --env "$SYNC_PRIVATE/sync.env" --state-dir "$SYNC_PRIVATE/state" --mode publish
```

模式默认 dry-run（可在专用 env 中指定 SYNC_MODE）；命令行 mode 优先。dry-run 实际读 Notion 与下载图片，验证 DTO／AST／字节，不调用 writer 或 Storage，也不修改 checkpoint／公开政策。由于不调用 begin，无法宣称已核对中央 deny、数据库 revision 或实时云凭据；这一项留到 stage／publish 的握手。

stage 使用真实 begin／stage／upload，但不 promote。v1 没有 finish-stage 操作，末尾调用 fail 释放租约；已暂存的行保留供管理员检查，状态是 failed，不能解释为发布失败或访客可读。只有 publish 成功返回后才写 last-success。完整核对每次从头读取，不基于 last_edited_time 跳过正文，也没有断点增量恢复。

## 完整性与媒体

完整枚举所有启用来源的 API 分页，只为获准候选复用当前运行的元数据；通过现有 repository 逐页复核身份、schema、归属与祖先，全部预检完成后才读正文。课程树按现有标题／ID 排序深度遍历生成 ordinal。Status 只支持指定来源 all；学习逐页允许，父页不授权新后代。所有采集会话和缓存仅存活本次运行。

Status与课程预检只检查准确直属来源／已选页，不读取未授权的外层容器；学习笔记仍严格检查所属课程和全部祖先。

begin 返回的 deniedPageIds 与已明确归档／删除／直属移出源的页面排除全部后代。名单中404、权限错误、未知父链、循环或资格不明确会终止批次，不能写删除证据。其他复杂移动按保守失败处理，交给统一策略流程确认。源禁用／名单修改必须先由管理员配置匹配 digest；worker 无权改策略。显式空配置仅在数据库握手与管理员已安装的空政策匹配时能发布空快照，源查询失败绝不成为空配置。

DTO 与 AST 复用核心 reader。v1 writer 仅接受内容路由面包屑，worker 去掉通用 `/study` 导航项，保留课程和全部学习祖先；未更改共享契约或 reader。真正不支持的块如实保留 partial；达到3000块／24层转换边界、错父或重复结构会终止，不能把截断伪装成普通 partial 并 promote。每条 record 先暂存，之后分批登记其媒体（每批≤100）；receipt 使用实际去重计数。

图片只接受 HTTPS:443、无 URL 凭据、无 fragment；DNS 所有答案须为可接受公网地址，IPv4／IPv6／映射／保留／隧道／metadata／私网被拒绝。每次重定向重新核对，最多3次；socket 直接连接已核对的 IP，TLS证书、SNI和Host仍校验原主机，防 DNS rebinding。没有代理或 Cookie／Token转发。总下载20秒、单文件20MiB，按实际流式字节大小、Content-Length、MIME与五种图片签名核对，禁止SVG／编码压缩。JPEG／PNG／WebP／GIF／AVIF保留原字节，未知尺寸为null；这些格式的签名检查不宣称是完整解码验证。显式配置本机转换器后支持HEIC／HEIF静态图片，解码后转换成JPEG，输出仍受同一大小／签名／哈希约束；详见下节。

图片请求默认带 `User-Agent: NotionBlogSyncBot/1.0`。v1／v2 同步及 v2 `website:db export --media` 可在私有环境设置 `SYNC_IMAGE_USER_AGENT`，填写实际程序名称、版本与公开联系地址；只接受 1–512 字符的可打印 ASCII，不接受空值、首尾空格或换行。这是向外部图片服务器发送的公开 HTTP 标识，不能填写 Token、私有链接或凭据，也不能冒充浏览器。Wikimedia 要求可辨识并可联系的客户端，见[官方 User-Agent 政策](https://foundation.wikimedia.org/wiki/Policy:Wikimedia_Foundation_User-Agent_Policy)。该配置不改变公网地址、TLS、格式、大小、超时与 HTTP 失败检查，也不修复访客直连时外部来源拒绝访问的问题。

媒体 ID 依照冻结 mediaIdentity，用 canonical owner＋cover／property／block locator＋SHA-256；objectKey 为内容地址。正文只有 `/media/<assetId>`，原始 URL 不持久化。相同字节跨 owner 共用一个对象键，资产 ID 保持独立归属。上传断开或必需图片无效则整批失败，不发布悬空引用。图片字节最多单图驻留，跨页仅保留描述；首版不删除失败残留、旧对象或历史批次，需要另行保护当前／回滚快照的垃圾回收。

JPEG／PNG的响应头误标按实际字节签名规范化到正确MIME；仅允许这两种静态栅格格式互换，未知／HTML／SVG及其他格式错配仍拒绝。Storage描述、上传Content-Type与字节验签均使用真实MIME。

## macOS HEIC 图片转换

真实采集可能返回image/heic；冻结Storage协议只接收五类浏览器图片，因此不把HEIC原样上传。可选的SYNC_HEIC_CONVERTER_PATH指定绝对路径、当前用户拥有且不可由组／其他人写入的本机二进制；没有配置时明确拒绝HEIC。公共Swift源为scripts/notion-sync/templates/HeicToJpeg.swift，使用系统[Image I/O](https://developer.apple.com/documentation/imageio/cgimagesource)，不增加npm依赖或修改核心SQL／DTO。

在Apple Silicon Mac编译一次，输出放内盘私有bin目录（700）。不要每张图片现场编译；运行不需要Swift编译器。按本机SDK位置调整命令：

```sh
xcrun swiftc -O -sdk /Library/Developer/CommandLineTools/SDKs/MacOSX.sdk -target arm64-apple-macosx14.0 \
  scripts/notion-sync/templates/HeicToJpeg.swift -o "$SYNC_PRIVATE/bin/heic-to-jpeg"
chmod 700 "$SYNC_PRIVATE/bin/heic-to-jpeg"
```

转换前核验有界ftyp与HEVC静态图品牌，不接收序列。ImageIO再次确认HEIC类型、单图及最多6400万源像素／单边16000；按方向解码，输出最长边4096、JPEG质量0.9，只添加像素，不复制源GPS、EXIF日期或XMP。原始下载和输出各不超过20MiB，转换包含在图片总预算内（默认20秒，受限配置最多60秒）。子进程没有shell、来源URL或凭据环境，取消会SIGKILL并等待退出，临时原图／结果都在700目录与600文件中，结束或失败即清除。其他平台需提供等价受限转换器或继续明确拒绝；本阶段仅实测macOS。

## 有界运行、日志和恢复

默认工作预算1800秒，`--timeout-seconds` 为1–3600。Notion 启动间隔350ms、每次排队/HTTP9秒，SDK最多2次重试；遵守429／529 Retry-After（长冷却不会被SDK60秒上限缩短），POST源查询500不自动重试。图片每跳最多尝试两个已验证公网地址，响应头单次预算5秒，共享原20秒图片总预算；HTTP拒绝／限流、正文失败及取消不再尝试，不后台重试；数据库查询使用已有10秒连接／15秒statement／20秒query限制。云调用超时和SDK已进入的最长60秒退避可能使退出晚于工作预算，取消后不启动新请求或 promote。没有无限进程重试；人工重新跑完整 reconcile。

默认上限10000个候选、20000个媒体描述和1GiB去重图片总量；底层 API 分页／课程树／AST也有固定边界。超限明确失败，由后续评估调整，不能默默忽略。注入式 runSync 支持更严格预算。

数据库 lease默认300秒、30秒串行 renew；停掉并等待未完成 heartbeat后才 promote。renew失败、策略 revision变化、旧 fence 或取消立即停止。CLI 的本机O_EXCL锁跨进程；数据库全局 lease保护不同主机。崩溃可能留下本机锁与暂存对象，数据库租约过期才可接管；不自动偷锁。

```sh
"$NODE24" "$WORKTREE/scripts/notion-sync/cli.ts" --state-dir "$SYNC_PRIVATE/state" --status
# 停止所有该 worker 实例后，且记录的 PID 已不存在：
"$NODE24" "$WORKTREE/scripts/notion-sync/cli.ts" --state-dir "$SYNC_PRIVATE/state" --unlock-stale
```

报告仅有run UUID、模式／backend、匿名计数、实际HTTP请求数（CLI）、耗时、采样RSS与受控错误码；不打印上游错误、连接串、原始ID／标题／正文／URL。保留latest-run与最近10份run报告，stdout／stderr超过1MiB下次写报告时原位截断。成功checkpoint只在真实 promote 后推进。CHECKPOINT_FAILED明确表示已publish但本地记录失败；若 promote 响应丢失，客户端无法断言未提交，管理员核对数据库 run 状态后再完整同步。SQL原子性仍保证没有半批可读。

损坏／空的崩溃锁不能自动解锁：先确认所有进程与调度已停止，再私下核对 worker.lock，人工仅处理此锁。状态目录故障时优先修权限／空间，不能通过扩大权限、改公开名单或关闭TLS解决。离线／Token失效会报告错误；公开资格过期由网站按冻结协议失败，不回退mock。

## launchd 与上线交接

模板 `scripts/notion-sync/templates/launchd.plist` 不含秘密、StartInterval或自动重启，RunAtLoad与KeepAlive为false。替换所有占位符为正式 release、私有配置／状态、独立Node绝对路径，先 `plutil -lint`；不直接加载原模板。只有用户确定同步间隔、公开TTL和手动真实样本通过后，才添加StartInterval并记录唯一入口、超时、告警和备份映射。工作模式先dry-run，不默认定时publish。

后续安装：准备不可变release与锁文件依赖，在主机说明中登记版本，切换current并核验。将已审阅 plist 放用户 LaunchAgents，再 `launchctl bootstrap gui/$(id -u) <plist绝对路径>`；暂停／卸载用 `launchctl bootout gui/$(id -u) <plist绝对路径>`，SIGTERM会取消工作；状态检查 launchctl print＋上述--status。睡眠错过的触发不保证补齐，唤醒后人工reconcile；未设RunAtLoad时重启不立即运行，等下一间隔。故障不启用第二个cron或另一个自动重试器。此轮没有建立 Services发布或加载任何任务。

真实接入仍需只读Notion Token、当前私有来源配置、受限LOGIN、固定Storage endpoint／writer JWT、已安装同摘要migration与policy；本包不包含这些。由用户提供到私有文件，小样本覆盖Status、课程、子／孙页、图片和partial，Mac mini实际网络／TLS／JWT／匿名拒绝与网站读媒体另行验收。Vercel provider、生产内容与域名按用户后续明确指令衔接。代码的离线测试与各主机真实验收分别记录于PROGRESS和主机文档；不据此宣称国内／海外表现已验证。

数据库导出和独立图片字节导出继续使用冻结后端CLI；仅manifest没有图片。云端恢复、私有配置备份／取回、无旧资格激活都需取得实际证据，首版不自动清理或启用备份任务。

## 手动小样本暂存

库入口runSync的stagePageIds只用于stage模式，最多100个已批准节点；仍完整分页及执行全部候选／中央deny预检，然后只读取与上传选定内容。学习样本必须包含课程和全部祖先，未知／撤回节点或重复项明确失败；不发送移除证据。报告标记sample=true，不调用promote或checkpoint；publish和dry-run传该选项均拒绝。CLI完整同步默认行为不变，样本ID只在受保护本机辅助入口传入，不写命令行或报告。暂存样本不能被当作完整快照发布。

较慢目标网络可在受保护环境配置SYNC_IMAGE_TIMEOUT_MS与SYNC_IMAGE_HEADER_TIMEOUT_MS；总图片预算1–60000ms，单地址响应头预算不得超过总预算。默认仍为20000／5000ms，最多两个地址，共享总预算，不增加后台重试。延长等待不能绕过HTTP拒绝、格式、大小或公网地址校验。

图片连接池只复用相同已校验IP及TLS域名的连接；每次请求／跳转仍完整校验当前全部DNS答案，HTTPS认证和Host不变，不保留Cookie。最多4个socket、每个目标1个空闲连接，空闲超时5秒；只有响应完整消费后才保留，重定向或失败立即销毁连接。没有凭据环境或隐式DNS解析进入图片请求。

若Notion／上游把HEIC字节误标为JPEG或PNG，仍依据经过验证的ftyp静态图品牌调用显式配置的有界转换器；不直接信任响应头。没有转换器则拒绝，转换结果必须为验签通过的JPEG。HEIC响应头对应非HEIC字节仍拒绝。
