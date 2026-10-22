# 固定社交周期与浏览器驱动

本项在已有固定计划、二十项执行器和两份 SQLite 上增加周期排空，以及专用小红书浏览器扩展。原受限 worker／reader、云协议、展示审批及页面 DTO 不变。代码和草案完成不表示调度或浏览器扩展已经启用。

## 周期与断点

实际采样周期仍为 B 站六小时、小红书二十四小时；每十五分钟仅检查本地到期状态，未到期不请求平台或云端。各项采样时间不同，仅每六／二十四小时启动一次，会让刚差几分钟到期的作品多等一个完整周期。检查频率不是统计采集频率，也不保证上游瞬时新鲜。

每轮冻结开始时已到期／待传的键，期间新增到期项留给下轮。B 站最多八批，每批二十项、120 秒和 32MiB；整轮另有十六分钟、160 次来源请求、128MiB 累积读取上限。全局预算跨批次保留，不随重新打开单批执行器重置。来源仍是公开视频页面，原一秒间隔保留。

小红书最多三十二批，每批五项，整轮三十分钟。投影需在五分钟内提交，全任务先验证身份及字段再写来源；近期 pending 直接补送，不重新开页。每批一个事件，用三十秒一次性 continuation alarm 接续，避免整个目录塞进一个超过 Chrome 五分钟限制的事件。Chrome 关闭、电脑睡眠或来源变慢时不能保证整轮覆盖；预算结束如实记录剩余数量。

普通共享源锁 BUSY 只延后：B 站下一次本地检查继续，小红书用 continuation 等锁，不当作需要人工恢复的验证失败。已完整验证、属于当前任务的投影暂存在 SSD 的原私有周期记录，锁释放后复用原捕获时间提交，不重新开页；任务超过五分钟才丢弃旧投影、重新捕获。Chrome 不持久保存统计。

原 SQLite 来源／outbox 事务保留断点，匹配键及 SHA 的实际云回执才确认。`cycle-bilibili/latest-cycle.json`、`cycle-xiaohongshu/latest-cycle.json` 保存冻结键、实际数量、剩余项和暂停状态，成功整周期另写 `last-successful-cycle.json`。报告私有，普通输出只含数量／状态；单批成功不等于整周期完成。

```sh
node scripts/social-sync/cycle-cli.ts plan /ABSOLUTE/PRIVATE/runtime bilibili
node scripts/social-sync/cycle-cli.ts status /ABSOLUTE/PRIVATE/runtime bilibili
node scripts/social-sync/cycle-cli.ts run /ABSOLUTE/PRIVATE/runtime bilibili
# 处理暂停原因后人工恢复，调度器不得调用 resume。
node scripts/social-sync/cycle-cli.ts resume /ABSOLUTE/PRIVATE/runtime bilibili
```

旧运行包保持暂停／取消须人工恢复；下述 B 站恢复只有换到确定的新 release 才生效。本项目 Mac mini 已独立切换 B 站，空闲自然检查、真实采传及一次异常诊断后的有界人工续跑已验收；首个非空自然周期本身仍是暂停结果，见 [安装记录](progress/2026-10-13-bilibili-refresh-activation.md)。验证或上传异常仍锁定后续自动运行，不每十五分钟重撞故障。B 站人工 `resume`，小红书点击扩展按钮恢复；小红书 alarm 无恢复能力。待审目标跳过，其余固定目标继续刷新。新作品、成员／分 P、类型或作品关联变化不自动获展示资格；本项不扫描账号发现新目标。

## B 站状态与临时故障恢复

`status` 只核对原本地配置、SQLite 和回执，输出数量、实际采样／上传时间、下一次到期时间、恢复状态与最近一次运行成本。不请求平台、不连接云库、不写采样或周期回执；核对期间仍使用短暂本地锁。历史记录没有的上传时间与成本为 null，不能把本地检查时间当成采样时间。空闲自动轮只做一次本地检查，不重新采集。

自动轮在 SSD 私有 `cycle-bilibili/health.json` 保存汇总：最近检查、成功采集、匹配云回执的上传时间；到期／待传／待审数量；连续失败、重试期限；检查、采集、上传耗时、来源请求数／响应正文读取字节、Node CPU 时间和峰值 RSS。普通 stdout 不含作品 ID、链接、私有路径或凭据。正文读取字节不等于网络线速流量；峰值 RSS 是当前 Node 进程的峰值，包含启动、排除 Chrome，不代表系统整体开销。一次检查不能外推全轮采集峰值。

仅 `SOURCE_NETWORK_ERROR`、`SOURCE_TIMEOUT`、HTTP 5xx 对应的 `SOURCE_TEMPORARY_ERROR` 和 HTTP 429 对应的 `RATE_LIMITED` 允许自动恢复。初次失败后至少等待 15、30、60 分钟，最多三次延期恢复；再次失败转人工。429 的有效 `Retry-After` 更长时遵守更长期限，超过一天或极端期限转人工核对。期限前的十五分钟检查不发来源请求，也不消耗重试次数。共享源锁 BUSY 只延后，保留原失败预算。

恢复需要当前范围摘要和原暂停周期时间完全匹配；旧暂停回执、缺少有效恢复证明、身份／成员变化、验证、HTTP 其他 4xx、结构解析异常、预算、取消和不明确的上传错误都不自动恢复。上传错误尚不能可靠区分短暂网络与权限／协议问题，因此保留人工处理。失败不改旧数字或采样时间；人工恢复优先复用现有待上传负载与原捕获时间。每个实际周期继续冻结目标并遵守原批次、请求、字节及时间上限。

这项优化没有改变调度频率、浏览器扩展、系统权限、云端协议或展示范围。安装与真实自然周期验收按固定 release 进行，工程验证见 [进度](progress/2026-10-13-bilibili-refresh-health.md)，实际安装见 [记录](progress/2026-10-13-bilibili-refresh-activation.md)，范围见 [决策](decisions/2026-10-13-bilibili-refresh-recovery.md)。

## 已批准合集的自动跟随

操作者在 B 站独立私有 `bilibili-follow.json` 写入 `{version:1,baseScopeDigest,collectionKeys}`，只列已有合集键，并绑定原共享配置的标准化摘要；同时在云端长期展示的已批准行启用 `follow_public_members`。B 站加载时仅为这些合集派生 `membershipMode: "follow-public"`，两端缺省均保持固定成员。原 `refresh-config.json` 字节不改，旧小红书运行包继续读取原配置；未知／重复键、原范围变化或损坏设置明确拒绝 B 站跟随，不影响小红书读取。原 `memberShas` 留作启用基线，跟随模式不逐次改写配置摘要或给予 worker 审批权，新账号、合集、独立视频和其他平台不自动进入范围。

原采集器仍要求作者／合集一致、公开且非付费、完整成员目录与原数量／字节边界。当前有效目录可增删成员；未知分 P 完整性如实保留，只有可证明的新 CID 才产生分 P 更新。已有待审候选在新范围下重新判定；恢复采集使用新鲜平台响应，不直接把过期候选当成现在的统计。

新增迁移仅在 `retained_collections` 增加默认 false 的私有列，并替换两个现有触发器函数。固定模式保持原精确版本和活动保留逻辑；跟随模式在原 ingest 事务内更新同一张卡及成员折叠，保留操作者启用基线、链接核对时间和审批时间。新成员可更新内容活动，单纯统计不制造新增；关闭绑定或撤回批准清除跟随，重新开启来源不会自动复批。worker／reader 不获该列权限或触发器调用权。

关闭跟随时由操作者将当前已接受成员签名／来源摘要作为新的固定基线，再设置 false；不能将旧基线盲目套回已变化的内容。运行切换需要核对云端模式、本地配置及固定 release，并保留原备份，代码合并本身不安装或启用跟随。

本项新规则补充本文前述逐成员审核限制，原六小时采样、十五分钟检查、单连接、有限重试和暂停边界保持。见 [决策](decisions/2026-10-14-bilibili-follow-collections.md)及[本项进度](progress/2026-10-14-bilibili-follow-collections.md)。

## B 站周期上传会话

新候选 B 站周期内只在实际上传时惰性打开一条原受限 worker 连接，视频和合集首次使用时分别核对原角色与协议版本；跨二十项批次复用，周期结束关闭。独立单批 CLI 和小红书保持原连接方式。代码不会自动替换 Mac mini 固定运行包，安装及真实验收见本项 [进度](progress/2026-10-13-bilibili-cycle-upload-session.md)和 [决策](decisions/2026-10-13-bilibili-cycle-upload-session.md)。

`health.json` 新增可选 `uploadCost`，`status` 对应 `lastUploadCost`，旧回执缺少时为 null。字段包括 connectionAttempts／connections、connectMs、handshakeAttempts／publicationHandshakes／collectionHandshakes、handshakeMs、ingestAttempts／receipts、ingestMs、closeMs；尝试数包含失败，receipts 仅记录验证并传回执行器的回执，不代替 SQLite ACK 数量。时间覆盖相应阶段的请求及本地校验，不代表 PostgreSQL 服务端执行时间。空闲检查各项为零且不连接云端，清理成本在健康回执保存前计入。

角色／版本校验、逐项范围与 key+sha 回执核对不省略。批次或整周期取消、提交后丢响应、连接错误、凭据／范围变化保持 pending 并结束当前会话，不内部重连或提高并发。默认 max=1、原连接／查询超时和来源节流不变；清理失败进入人工处理，原云端 SQL、权限、展示及重试规则不变。

## Chrome 与本机消息

`scripts/social-sync/browser/` 是本项目独立编写的 Manifest V3 扩展，复用操作者登录 profile；无需远程调试、Cookie 导出、HTTP 端口或新的常驻服务器。

权限为 `alarms`、`scripting`、`nativeMessaging`、`storage`，host permission 仅 `https://www.xiaohongshu.com/*`。**Chrome 授予整个该域的脚本能力**，不能按笔记 ID 细分系统权限；代码／本机协议进一步限定已审核 ID、作者和地址。安装时须审查这一持久权限。没有 `cookies`、`debugger`、`webRequest`、全站 host permission、外部消息入口或网页 content script。

扩展只新建不抢焦点的标签，一次开一篇，对该标签主 frame 执行固定 MAIN 函数。函数核对当前路径／ID／作者，读取窄字段，不遍历正文、评论或账号目录；返回标题、类型、数字、已知日期和第一封面，近似计数按原协议保存。成功／失败均关闭自己的标签，恢复清理也只处理登记且仍处于对应笔记路径的标签。原用户标签不参与。

`connectNative` 启动短生命周期宿主，以标准输入／输出的一条长度帧交互，回复后关闭输入并退出。只接受私有配置和 NativeMessaging manifest 中固定的单一扩展 origin，输入上限约 264KiB；无自由路径、SQL、shell 命令或脚本字段。服务端决定目标／分享地址／凭据；返回扩展的只有当批身份、URL、期限和数量，没有数据库密码。

浏览器任务保存 scope 摘要、五项来源版本和五分钟期限；提交前及来源锁内都核对，人工更新的来源不能被旧任务覆盖。完整确认的相同任务／负载可重读保存回执；不同负载冒用已完成任务拒绝。若进程在保存桥接回执前退出，原 source/outbox 仍是断点，下轮按真实状态补送或跳过，不伪造成功。

## 安装草案与 SSD

私有运行目录沿用 `refresh-config.json`、`cloud.env`（600）和已有 SQLite。新增 `browser-links.json`，格式 `{version:1,links:[{publicationId,url}]}`，包含配置内所有小红书目标实际已核对的 https 分享地址；不重新复制链接或改变原核对时间。个人值留忽略目录。

```sh
node scripts/social-sync/prepare-runtime.ts /ABSOLUTE/PRIVATE/runtime /ABSOLUTE/PRIVATE/package
```

生成器输出带固定 public key 的 SSD 扩展包、单一 origin 的 native manifest／启动器、独立 Dagu YAML、`enabled:false` 的桥接／调度记录。已有包或桥接配置时拒绝覆盖。它不注册宿主、加载扩展、复制工作流、真实采集或写云端。

macOS 输出 `NotionBlogSocialRefresh.app`，manifest 指向它的 `Contents/MacOS/native-host`。生成的私有 C 源用固定参数启动 Node 子进程，App 父进程等待并转发终止信号，以保留专用应用的系统权限归属；不经过通用 shell，也不接受额外参数。源码把 UTF-8 路径编码为 C 字符串，避免引号或 shell 字符改变命令；Node 模块文件路径含反斜杠时明确拒绝。构建使用本机 `/usr/bin/clang`（需已安装 Command Line Tools）与 `/usr/bin/codesign`，执行 ad-hoc 签名和严格验证。编译／签名失败报 `REFRESH_MAC_LAUNCHER_BUILD_FAILED`，不降级到 shell，不写启用配置。其他平台保留只接受固定 origin 的 shell；本项没有验证 Windows 安装。

`native-launcher.c`、App、`native-launcher-review.json` 与配置均留 SSD 私有目录，审核记录不表示已获系统授权。macOS 可移动宗卷权限属于应用身份；同 bundle ID 的新编译或迁移不保证继承旧权限。不能通过给 `/bin/sh` 完整磁盘访问来代替专用应用授权。签名和消息协议依据 [Apple 签名说明](https://developer.apple.com/library/archive/technotes/tn2206/_index.html)及下方 Chrome 文档。

安装须先从确定提交生成并核验独立 SSD release，启动脚本和 YAML 指向 release，不能长期执行可编辑工作树。Dagu candidate 复用现有调度器：独立工作流、Melbourne 时区、十五分钟检查、1000 秒 timeout；不替换网站／图片工作流或使用它们的锁。

Mac Chrome 要求一个用户目录注册 JSON：`~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.notionblog.social_refresh.json`。它只保存 SSD 启动路径与 origin，不含凭据／采样。源码、扩展包、SQLite、统计、分享地址和凭据留 SSD；原 Chrome profile、扩展登记和少量 alarm／自有标签状态仍归 Chrome 管理，不能宣称内置磁盘零写入。此外，已有 Dagu 工作流目录登记一个小 YAML 启动指针，任务的数量／状态日志仍由原调度器管理；本机核对这些目录也在内置用户目录。它们不含业务快照或数据库密码，业务数据库和采样记录保持在 SSD。

启用前审查具体 release、权限和 manifest，获准安装后先做有界真实驱动验收，再开周期。回滚为关闭 bridge `enabled`、禁用／卸载扩展、移除该 native manifest 和独立 Dagu 工作流，保留 SQLite、私有回执及原网站／图片调度。

## 恢复与迁移

恢复优先保留原冻结 release、整个已签名 App、扩展 manifest 的 `key`、两个 SQLite／outbox、私有配置与分享地址。原卷恢复到同一绝对路径时先核对原登记、App 签名和 `settings` 消息，再检查本地到期计划；不要把旧 `prepared.json` 的 disabled 草案当成当前安装状态，也不要重采全部内容来验证恢复。

需要重建启动器时，使用确定提交的 release 执行以下命令。它从既有私有 `bridge-config.json` 复用 origin，只输出新的独立候选目录，不修改该配置或当前 App、Chrome 登记、扩展、Dagu 和周期状态：

```sh
node scripts/social-sync/native-launcher.ts /ABSOLUTE/PRIVATE/runtime /ABSOLUTE/PRIVATE/new-launcher-candidate
```

检查候选的 `native-launcher-review.json`、原 origin、固定 release／Node／runtime 路径与签名后再做安装。不能直接重新运行完整包生成器：那会产生新的扩展 key；已有 bridge 时生成器会拒绝覆盖。迁移到新挂载路径或新 Node 路径需要重建候选并审核 Chrome／Dagu 指针，新机器或签名改变可能要求再次手动允许专用应用的可移动宗卷访问。准备候选不自动申请该权限或注册新路径。

切换前暂停本项 bridge 和独立工作流，等待自己的正在运行任务退出，备份旧 manifest、YAML、签名 App 和配置；不停止其他工作流、不清 outbox。候选经实际 Chrome `settings` 连接验证后才恢复既有周期。若连接失败，将登记恢复为原 App 路径并按原批准范围恢复；不能靠普通终端成功冒称 Chrome 系统权限已经通过。构建失败留下的未注册候选需先审阅，再移除或换新目录重试，避免覆盖已安装文件。

机制依据：[Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)、[MAIN 执行世界](https://developer.chrome.com/docs/extensions/reference/api/scripting)、[alarm 延迟／睡眠](https://developer.chrome.com/docs/extensions/reference/api/alarms)、[service worker 生命周期](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)、[固定扩展 key](https://developer.chrome.com/docs/extensions/reference/manifest/key)。离线驱动测试不替代实际 Chrome 安装和自然周期验收。


## 小红书固定清单 HTTP 候选

已有真实分享地址的笔记可采用窄 HTTP 适配，详见[决策](decisions/2026-10-14-xiaohongshu-http-refresh.md)。依赖只在 SSD 独立 Python 环境安装 `scripts/social-sync/python/requirements.txt` 的四个固定版本，不修改网站 npm 依赖。匿名会话不读取 Chrome、登录 Cookie、代理环境或签名器；`curl-cffi` 的 Chrome 请求配置不能代表真实浏览器认证或长期成功率。

```sh
node scripts/social-sync/prepare-xiaohongshu-http.ts /ABSOLUTE/PRIVATE/runtime /ABSOLUTE/PRIVATE/new-candidate /ABSOLUTE/PRIVATE/python/bin/python
node scripts/social-sync/http-cycle-cli.ts status /ABSOLUTE/PRIVATE/runtime
node scripts/social-sync/http-cycle-cli.ts plan /ABSOLUTE/PRIVATE/runtime
node scripts/social-sync/http-cycle-cli.ts run /ABSOLUTE/PRIVATE/runtime
node scripts/social-sync/http-cycle-cli.ts resume /ABSOLUTE/PRIVATE/runtime
```

准备命令只生成新独立库、`enabled:false` 的 `xiaohongshu-http.json`、`prepared.json` 和未登记的 Dagu YAML；候选目录必须不存在，不覆盖旧库或活跃配置。sidecar 绑定原规范化范围摘要、分享地址文件摘要、独立状态目录和 Python 绝对路径；同库或父子目录拒绝，配置／链接改变后停止执行。候选复制完整固定键历史与 outbox 状态，保持旧日期、摘要、acked／pending 和尝试记录；它不重采或上传。

启用前安装 `20261014022855_social_xiaohongshu_http_source.sql`：原 meta 新增能力列、原校验函数接受两种来源；原函数身份／ACL、版本 1、RLS、绑定和展示审批保留。新 HTTP 客户端在首个源请求前检查受限角色与能力，未安装时保持暂停。旧发送器不发送新来源，旧 B 站程序读取原共享库；新 HTTP 库只能由新程序读取，不能改名迁回原库。

`plan`／`status` 只检查本地状态；未启用时 `run` 不启动 Python 或连接云端。运行阶段五篇一批，每轮一个 Python 会话与一个受限数据库连接，退出后释放；每批之间检查完整 sidecar 和范围，原窗口不能被新到期内容延长。旧浏览器暂停先保留为人工恢复要求。首个失败将原因和 `check`／`preflight`／`capture`／`upload`／`close` 阶段写入独立 `cycle-xiaohongshu-http/health.json`，`latest-cycle.json` 留固定键和剩余进度；公开到调度日志的摘要只含数量、状态、日期和成本。Python 峰值 RSS／CPU 为该子进程测量，不能当作全机或完整 Node 周期开销。

恢复先读 `status`，处理验证／身份／权限或输入变更，再执行 `resume`。近期已完成采样的 pending 直接补传，精确回执才能 ack；过期 pending 按到期规则重新采集，旧数字在网站仍保留。限流／暂时故障不自动循环重试，`Retry-After` 不自行解除暂停。只有本地锁竞争允许下次十五分钟检查延期；恢复碰到锁时原失败原因保持。

实际安装使用冻结 release 的 CLI、候选 Native App 与原扩展身份；只更新已有背景脚本，不增加域权限或 Cookie／debugger 权限。启用后旧 XHS alarm／任务返回 `http-managed`，B 站任务保持独立。新增的独立 Dagu 文件每十五分钟检查，1850 秒上限，复用现有调度器，不新增常驻服务；配置草案不能作为已安装证明。先验收一篇到期笔记，再开放原清单周期。失败时保留独立库、关闭 HTTP sidecar／工作流并恢复旧运行指针和真实浏览器采集；不重写来源或云端历史。代码合并本身不会执行这些安装动作。

## B 站账号自动发现候选

用户已要求同账号新公开投稿自动接入。`bilibili-account.json` 将显式账号授权绑定原共享范围摘要；`bilibili-discovered.json` 只追加本账号的已核对发布／合集，原小红书程序和共享文件不变。浏览器只读取该账号投稿页的渲染链接和真实分页，首屏记录实际页大小，后续页必须保持总数、去重和末页完整。每六小时发现一次，每十五分钟先检查 SSD 状态；已有多 P／独立视频的类型变化复用正常详情请求的本地分类记录，不另行采样。

未知目标经原匿名 HTTP 页面核对完整作者、公开状态及合集口径，分批写本机 outbox、再经账号专用函数原子登记和接入。每事件最多三个新详情请求／九十秒，发现处理每六小时窗口最多二十请求、一百二十八 MiB／十六分钟；数据库单连接、超时及匹配回执保留，验证和身份异常暂停。锁竞争延期；已完成采样的批次先保存 SSD，避免因等待锁重新请求平台。正常旧目标刷新保持原预算，不因目录失败停止。

新合集还需在同一已登录浏览器访问实际合集入口并核对代表成员，再登记跳转证明；未完成时链接保持 null，不能将生成的规范地址伪装为已验证。同一合集的成员、多 P 子卡片都折叠，父合集撤回后子卡恢复；显式 standalone override 保留。

`prepare-account-upgrade.ts` 只生成默认关闭的安装候选，复用现有扩展的 key／origin 和专用启动器方案，新增 `https://space.bilibili.com/*` 域脚本权限，不取得 cookies／debugger／完整磁盘访问，不新建常驻服务。需先完成候选和浏览器域权限确认，再安装账号授权、受限函数与固定运行包；代码合并本身不切换程序或部署网站。原固定清单行为仍适用于未启用账号模式的环境。
