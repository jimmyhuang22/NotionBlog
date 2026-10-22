# 游戏账户同步与 Mac mini 接入

游戏平台数据先写入 Notion 的「平台游玩记录」，通过关系关联现有 Game 作品；网站内容 worker 再按获准来源采集 Notion。两个程序方向不同，使用不同私有配置和运行目录。本模块不修改网站 DTO、冻结同步 v1、SQL、发布名单、栏目开关或原内容 worker；网站展示范围以现有来源配置为准。

## 字段归属

Game 保留标题、版本、封面、个人评分、状态、日期、笔记和原有 `Played Time`。平台记录按「Provider + Account 别名 + Platform + Product ID」形成 SHA-256 `Sync Key`；同一作品的 PC、PS4、PS5、Switch 与 Switch 2 产品分开记录，不按相似名称自动合并。

| 位置 | 属性 | 含义 |
| --- | --- | --- |
| Game | `Platform Records` | 双向关系，连接已确认属于该作品与版本的平台记录 |
| Game | `Platform Playtime Minutes` | 关系中平台累计分钟之和 |
| Game | `Platform Time Count` | 有时长数值的关联记录数量，真实零也计数 |
| Game | `Playtime Hours` | 有平台时长时用平台分钟／60；否则保留原手填小时；两者未知时为空 |
| Game | `Platform Last Played` | `Platform Records` → `Last Played` 的 `latest_date` 汇总；人工 `Date` 不改写 |
| 平台记录 | `Provider`／`Account`／`Platform`／`Product ID`／`Sync Key` | 稳定身份；Account 是本地别名，不存平台真实用户 ID |
| 平台记录 | `Game`／`Sync Status` | 已关联 Current、待确认 Needs review、排除 Excluded |
| 平台记录 | `Total Playtime Minutes`／`Playtime Hours`／`Playtime Precision` | 原始分钟、派生小时、Second／Minute／Approximate；未知为空，零为 0 |
| 平台记录 | `First Played`／`Last Played`／`Source Updated At`／`Synced At` | 平台实际首末日期、最近一次资料变更写入所用的源更新时间及采集时间，未知不推断；每次采集时刻另存私有快照及回执 |
| 平台记录 | `Record Scope`／`Ownership` | Library／Played／Trophies 与平台原始库状态；有游玩记录不等于已购买 |
| 平台记录 | 奖杯组、完成率、获得数、总数与白金数 | 独立奖杯统计；不改个人通关状态，也不当剧情进度 |
| 平台记录 | `Recent Playtime Minutes`／`Product Type`／`Product URL`／`Platform Release Date` | Steam 最近两周分钟、游戏／试玩／模组／测试分类及平台资料 |

Game 时长公式为：

```text
if(prop("Platform Time Count") > 0, prop("Platform Playtime Minutes") / 60,
  if(format(prop("Played Time")) == "", "", prop("Played Time")))
```

不同平台时长相加表示账户报告的累计量，不能校正平台重复计时、移植后的存档或离线遗漏。资料不匹配时只建平台记录，放在「待匹配作品」视图，不创建重复作品。扩展章节可能只有本体合计时间，不能把本体时长分摊到章节。

网站只读连接需要能读取参与 Game 关系及汇总的关联来源，否则 Notion 可能返回空关系，使有效小时沿用旧手填值。平台记录库只提供必要的关联读取，不注册为网站内容来源、不公开原始账户数据，也不增加网站连接的写入能力。权限调整后同时核对网站 reader 与游戏 writer 的读取结果，覆盖未知、真实零时长及跨平台记录；不能只用旧手填样本证明汇总正确。官方说明见 [关联属性读取](https://developers.notion.com/reference/page-property-values#relation)。

人工确认的作品绑定同时写入私有 `bindings` 配置，保留已有排除规则。只更新关系及核查说明，不改平台累计值或伪造采集时间。配置变化后重新采集及 dry-run，旧配置摘要对应的计划不能继续用于写入；日常维护不自动启用持续同步。

旧 Steam 宽表字段保留作迁移兼容，常用 Game 表显示有效小时和关联记录。Game 页面把状态、评分和有效小时置顶，按个人体验、作品与版本、平台游玩、历史与兼容组织属性；历史手填和旧 Steam 字段隐藏显示而保留原值。平台页按作品与游玩、奖杯、平台资料和同步标识分组。原 `Progress` 保留历史估算含义，不改写为平台奖杯比例。旧字段删除需等持续 worker 实际复读验收并核对读取方，不能仅因本轮迁移成功就删历史数据。

常用游戏画廊按原 `Date` 降序、`Name` 升序排列，资料整理和账户同步不再借编辑时间改变体验顺序。Playing 卡片保留原名称、平台和评分，从视图隐藏旧 `Progress`；原公式和原值仍保留，未知体验日期不补造。

网站另采用平台最近游玩优先的浏览日期。v2 来源配置把 `lastPlayedDate` 映射到 `Platform Last Played`；读取支持普通日期属性及完成的 `latest_date` 日期汇总，错误聚合、不完整或不支持的汇总明确失败。平台记录继续私有，不作为网站的新增内容来源，浏览器只得到作品上的汇总日期。

Game DTO 的 `lastPlayedDate` 是兼容可选字段；新采集返回日期或 null，旧批次缺字段时沿用人工 `playedDate`。来源映射改变后需要同版同步程序、配置摘要和已获准发布策略共同接入，再让新的批次进入网站；不要把新字段写进仍运行旧解析器的输入，也不要为日期修复重抓游戏封面或扩大账户范围。网站前端发布与运行包安装分别按正常交接执行。

新建平台库已解除父页面分享继承、关闭 Notion 网站发布并核对 General access 为 Only people invited。个人目录和账户记录先留在受邀后台；页面属性隐藏只改变显示，不能代替权限或网站来源允许名单。关联的原作品页面继续原有发布设置。

## 平台能力与边界

PSN 使用锁定的第三方 `psn-api`，不是索尼面向公众承诺稳定的个人数据 API。读取本人完整 played-games 分页和完整奖杯清单，按产品与奖杯组核对 `hiddenFlag`；未确认隐私的产品只留本地。购买但从未玩过的全部 PSN 游戏不在本采集范围。累计秒转换为带小数的分钟，白金／奖杯与人工状态独立。NPSSO 换短期访问令牌与刷新令牌，失效或撤销时需本人重新登录。[实现与认证说明](https://github.com/achievements-app/psn-api)、[游玩记录](https://psn-api.achievements.app/api-docs/users)、[奖杯接口](https://psn-api.achievements.app/api-docs/user-trophies)。

Nintendo 使用 Store／My Nintendo 账户游玩历史路径及 PKCE 登录，没有通过家长控制或 NSO 的第三方签名服务读取凭据。当前采用全球 Store v2；旧接口仅保留显式代码选项，不静默降级。平台码 BEE／HAC 对应 Switch 2／Switch 软件，不能据此推断实际拥有的主机。隐藏列表缺失或未知平台时不放行。账户历史可能延迟一天，并不是完整购买清单。[Nintendo 官方游玩历史说明](https://en-americas-support.nintendo.com/app/answers/detail/a_id/68647/p/1128)、[Store 登录参考实现](https://github.com/raycast/extensions/tree/main/extensions/switch-game-play-history)、[全球 v2 接口变动](https://github.com/vm0-ai/vm0/issues/20608)。

Steam 账户 Key 的拥有列表可能包括私人游戏，客户端隐藏也无法从公开游戏列表推断。默认人工模式要求一小时内、独立核验的 `steam-policy.json`：完整隐藏清单、私人清单、已确认非私人 ID 和产品分类。过期或缺失时停止；新 ID 只留本地待核验。不得把时间戳改为当前来绕过审查，也不得从账户 API 自动生成已验证名单。尚无持续刷新此证据的程序；用户另行选择的固定授权模式见下方每日运行，不把固定名单冒充实时隐私证据。[Steam 官方 IPlayerService](https://partner.steamgames.com/doc/webapi/IPlayerService)。

当前 Notion 连接写入的日期复读到分钟；PSN 时长的小数分钟仍保留秒精度。源原始时间留在私有快照，不能用显示精度证明秒值也已完整写入。

## 本机准备与单次运行

使用 Node 24–26。在完整项目检出中安装根依赖和独立平台依赖，不把 PSN 库加入网站运行包：

```sh
npm ci
npm ci --prefix scripts/game-sync --ignore-scripts
mkdir -m 700 .local/game-sync
cp scripts/game-sync/templates/credentials.env.example .local/game-sync/credentials.env
cp scripts/game-sync/templates/config.example.json .local/game-sync/config.json
chmod 600 .local/game-sync/credentials.env .local/game-sync/config.json
```

已有私有文件不能用模板覆盖。文件只允许当前用户读写、目录 700，不使用 shell source/eval 读取秘密。实际配置、凭据、认证缓存、回调、快照、计划和回执均留在忽略目录；回调成功后自动清空。

Nintendo 本人登录：

```sh
node scripts/game-sync/cli.ts nintendo-login .local/game-sync
# 打开私有 nintendo-login.json 的 URL。
# 本人登录后，复制 Select this account 的完整自定义协议链接到 nintendo-callback.txt（600）。
node scripts/game-sync/cli.ts nintendo-finish .local/game-sync
```

PSN 本人登录后，读取同一浏览器中的 [Sony ssocookie](https://ca.account.sony.com/api/v1/ssocookie)，仅把 NPSSO 填到私有文件，不发到聊天。填 `PSN_ONLINE_ID`，采集器校验本人身份；Nintendo 首次保存私有身份指纹，换账户时明确处理原绑定，不自动混入旧记录。

完成来源配置与受限 Notion 连接后，按平台串行运行：

```sh
node scripts/game-sync/cli.ts collect-psn .local/game-sync
node scripts/game-sync/cli.ts dry-run .local/game-sync psn
node scripts/game-sync/cli.ts apply .local/game-sync psn
node scripts/game-sync/cli.ts collect-nintendo .local/game-sync
node scripts/game-sync/cli.ts dry-run .local/game-sync nintendo
node scripts/game-sync/cli.ts apply .local/game-sync nintendo
```

Steam 在独立隐私核验完成且证据仍新鲜时使用 `collect-steam`、`dry-run ... steam`、`apply ... steam`。政策格式见模板；模板故意无有效核验，不能直接运行。`bindings` 用 `Provider:Platform:Product ID` 指向已确认的 Game 页面 ID，`excluded` 使用相同键。改动配置或快照后，先重跑 dry-run。

Notion 内部集成需要 Read content、Insert content、Update content，只直接连接 Game 和平台记录两个库；库内子页和内嵌数据库仍按 Notion 权限继承。程序额外校验来源，只写平台记录及其 Game 关系。网站只读 Token 不复用或提权。独立 `NOTION_GAME_SYNC_TOKEN` 已在 Mac mini 配置并完成身份、来源权限、真实写入及回读验证。后续沿用当前私有输入，配置或执行设备改变时重新核对，不重复创建集成或用历史交接包覆盖更新的会话。

## 执行、复核与交接

采集必须完整、有稳定身份且未经截断；隐私未知不创建。SDK 写入前查询完整现有集合、检查重复键和所有关联目标；保留用户已关联作品，冲突时整轮停止。更新不改现有平台展示名和 Game 个人字段。新隐藏条目只解除平台关系并归档平台记录，避免归档关系继续参与作品时长汇总；原作品不归档。不从上游暂时未返回推断删除。

collect 仅采集；dry-run 只读 Notion，保存版本 2 的精确字段计划、配置／快照摘要、来源 schema 及现有属性摘要。apply 要求快照一小时内，重新查询后核对整个计划；输入、绑定、schema 或相关人工属性已变时，以 `PLAN_CHANGED` 停止并重新 dry-run。旧版只有输入摘要的计划以 `DRY_RUN_REQUIRED` 拒绝，不能用于新程序写入。

真实变化才触发写入；只刷新 `Synced At` 或 `Source Updated At` 不触发更新。已有页只写变化字段及本次快照的采集时间，名称、人工核查、历史备注及缺失的奖杯统计保持。零与未知分别比较，日期按 Notion 实际分钟精度比较，Steam 同一产品的商店路径名称及追踪参数不算资料变化。无变化时 `unchanged` 计数增加，Notion 不写入；`create`／`update`／`archive` 分别表示新增、变化更新与隐私撤回，`unmatched` 统计本次允许但未关联作品的行，不等于异常或排除。

写入前再核对候选页，写后回读变化值和原有可写属性；平台小时及受影响 Game 的标准分钟／数量 rollup、有效小时和个人属性分别核验。一次短暂不一致最多回读三次，不重复发送 mutation。最终重查平台集合，核对重复键、未变化记录和已写记录；公式及 rollup 的预期变化不计作人工字段变化，文件临时签名刷新不计作更换。程序不调用正文写入接口，不遍历正文作逐块审计。实际 SDK 请求限速，限流和请求失败停止本轮，错误只输出安全代码和统计。

私有 `<provider>-receipt.json` 保存最新回执，`<provider>-receipts/<runId>.json` 保留逐次记录，均为 600、目录 700。每次请求前持久保存 `requesting`，收到页编号后保存 `written`，回读成功后登记 `completed`，整轮复核成功才标记 `verified`；失败保存已完成项及未确认请求，不输出作品或凭据。回执不能保存时停止，不继续写下一页。

部分写入失败可能留下已完成行：先检查私有回执，再重新采集、dry-run 和 apply。新计划按稳定键及当前值跳过已完成行，可能已成功的 create 不自动重试；不重放旧计划，也不回滚后来的人工作品修改。这不是跨页事务，也不能对多个主机并发保证唯一性。只部署一个写入实例；同一私有目录使用跨进程锁，进程上限十五分钟。硬退出留下锁及 running 回执时，先确认对应进程已结束，再处理锁并重新规划，不能直接覆盖运行中的状态。

Mac mini 已完成三平台手动真实 collect→dry-run→apply 和完整属性回读。独立 writer 的实际账户更新、reader／writer 关系与时长汇总、真实零与未知、个人字段、人工核查状态、历史备注及全部排除已验证；私有配置增量保留原绑定和排除。运行使用独立输入与锁，精确采集时刻保存在快照，Notion 日期按实际存储精度核对。账户维护与网站来源同步分别执行；周期、凭据续期与失败提醒按后续运行要求确定。

验证命令：`node --test tests/game-sync*.test.ts`、`npm run check`、`npm run build`。候选文件与真实账户信息不得出现在可提交示例中。

## 增量与持续运行状态

2026-10-12 的手动增量维护已实际验证：三平台重新采集，仅一条 Steam 记录的资料有变化，累计及最近两周各增加 20 分钟；其余平台记录保持，个人 Game 字段和小时汇总通过完整回读。

正式 CLI 已加入变化筛选、精确计划、写后回读和失败回执。工程测试覆盖零写入、时间精度、时长／奖杯／关联变化、隐私撤回、并发编辑、错误回读及部分失败续办。新的 Nintendo 实际 `collect → dry-run → apply` 中，120 条均未变化，正式入口实现零 Notion 写入。随后在新的独立隐私确认下实际更新 2 条 Steam 记录：累计分钟增加 60 的记录及一条最近两周分钟变化记录；程序回读和独立全库属性、4 个候选页正文核对通过，其余 340 条平台记录及全部 Game 个人属性保持。

故障路径通过模拟 SDK 与真实属性快照回放验证；不制造账户时长来测试。Steam 隐私证据持续刷新仍待安排；具体维护结果、资料口径与后续顺序见 [Notion 数据库维护与交接](NOTION_MAINTENANCE.md)。

## 每日账户运行

最新选择：本环境用独立固定允许／排除名单启用 Steam 自动阶段，三平台依次 PSN → Nintendo → Steam。`steam-allowlist.json` 沿用 [模板](../scripts/game-sync/templates/steam-allowlist.example.json)，必须明确 `mode=fixed-allowlist`、本人 `steamId`、实际授权的 `approvedAt` 及既有名单／产品分类；`reviewedAt` 保留历史核验时间，不伪造刷新。`verifiedPublicAppIds` 在本模式中仅表示固定批准范围，不是实时公开证明。

固定名单以用户同期维护为准：以后新设隐藏／私人游戏，需把 App ID 加进排除名单；Steam 的设置不会自动反映到此文件。排除优先，缺产品分类或未批准的新 ID 留本地待核。修改名单后重新采集及 dry-run，旧摘要不能继续 apply。原 `steam-policy.json` 保留人工证据，不覆盖；固定模式不要求每次人工确认，但账户身份、采集时效和回读检查保持。

缺少固定名单时每日入口仍仅 PSN／Nintendo；文件存在但损坏、模式错误或账户不匹配时停止，不能静默回退。以下原两平台验收保留为历史，最新安装状态见本项 [进度](progress/2026-10-12-steam-daily-allowlist.md)。

用户选择每天一次；Mac mini 已注册每日任务，安装后经 launchd 手动触发六阶段验证、退出 0，首个日历触发仍待观察。提供 `daily` 入口及 [launchd 模板](../scripts/game-sync/templates/daily-launchd.plist)，默认设备本地时间 09:00。使用支持的 Node 24–26 和独立固定代码 release，沿用当前私有目录，不能指向开发工作树或临时 npx 缓存。实际路径、代码／依赖摘要、安装与运行回执留在私有交接。

```sh
node scripts/game-sync/cli.ts daily .local/game-sync
# macOS 定时入口可加 notify，失败尝试发本机通知：
node scripts/game-sync/cli.ts daily .local/game-sync notify
```

一次 `daily` 持有同一个账户目录锁，依次执行已启用平台的完整 collect → dry-run → apply；采集失败时不继续使用旧快照、计划或另一个账户。每个 apply 继续核对精确计划和所有 mutation 的回读结果，整个周期最多十五分钟。该命令不接受额外平台参数；Steam 只能由独立有效固定名单启用。

`daily-receipt.json` 和 `daily-receipts/<runId>.json` 保存当前及逐次阶段，平台写入回执另存。输出只有统计及安全错误代码。`notify` 在 macOS 失败时尝试本机通知，不把作品、凭据或原始错误放入通知；显示仍取决于系统通知设置。PSN 沿用现有刷新缓存，Nintendo 每次换短期访问 token；本人登录会话失效或身份变化时停止并提醒，不自动换账户。不要在循环中重试可能提交的写入。

先手动运行固定 release 并核对回执，再注册唯一 `com.homelab.notionblog-game-sync` 用户级 LaunchAgent；模板 `RunAtLoad=false`、`KeepAlive=false`，不在加载时立即再跑、不持续失败重启。设备睡眠或未登录会影响执行，不能承诺严格日历时刻。查看任务用 `launchctl print gui/<uid>/com.homelab.notionblog-game-sync`，停止用 `launchctl bootout gui/<uid>/com.homelab.notionblog-game-sync`；移除定时入口不删除已有账户快照或个人 Notion 记录。

每日账户任务只更新 Notion，不运行网站内容 worker、不续网站批次资格、不部署网站。网站内容仍按其独立同步与资格规则更新。

## 版本确认后的关联维护

新增可靠关联使用 `Provider:Platform:Product ID` 更新私有 `bindings`；`Sync Key` 是账户去重摘要，不能代替该配置查找键。保持全部已有绑定和排除项，下一次实际执行前重新采集及 dry-run，旧导入摘要不继续作为写入计划。Nintendo Switch 2 记录须区分兼容运行与升级版，试玩、活动、服务和合辑不能按近似标题分摊到正式游戏。原页采用组合标题时，只计已核实的具体版本账户记录，不推断另一版本的所有权。

商店完整 SKU 可能包含与软件执行标识不同的购买范围；同一个软件 ID 不证明正式版、好友通行证、DLC 或合辑权利。维护备注按缺少已确认原页、不同平台／版本、试玩／活动、服务／工具及合辑范围分类，并写明来源或当前证据限制。备注更新不伪造采集时间，不改变原始账户数值；未核实关系继续待复核。

平台的人工 `核查状态` 独立于 `Sync Status`；当前请求生成器不写人工核查状态、`Review Notes` 或原展示名称，实际更新这些平台记录时保留它们。新记录由空分类进入待匹配视图；试玩／服务的“无需关联”不等于自动同步的 `Excluded`，也不触发归档。

用户授权补齐缺失作品后，人工维护可按官方账户软件标识和发行商资料建立 Game 页，再关联平台记录。新页只填写作品名、软件版本、资料来源、核查日期及有依据的发行日和封面；个人评分、游玩状态、体验日期、拥有平台、手填时长和心得保持空白。不自动套用含个人默认值的模板；已有作品的人工字段保持原值。

Nintendo 软件标识可通过官方 `ec.nintendo.com/apps/<software-id>/<region>` 路由查询，再核对产品中的 `applicationId`。同一标识的当前展示名称或运行设备可能带有 Switch 2 字样，须以软件身份区分原版、兼容运行和升级权益。地区查询仅说明资料来源地区，不能据此填写个人地区；引用地区发行日时在版次或核查备注写明口径。合辑启动器只汇总其软件记录，不分摊到内含作品。

购买商品 SKU 与账户软件统计身份分别核对：某软件前缀出现在合集商品或扩展商品中，不能单独据此认定账户记录是合集启动器、包含所有内含游戏的时间或取得扩展权益。用户已确认的组合页包含该本体时，可关联已核实的本体软件记录，保留实际分钟、奖杯和原个人版次；无需因普通软件标识不证明 DLC 而重复询问已有的版本确认。

封面采用与作品及版本相符的官方素材，保存到 Game 的 `Cover` 文件属性，并保留来源和文件摘要。没有可靠素材时留空。关系及配置更新后重新采集，先 dry-run 再 apply；真实写入后的核对覆盖全部原属性、人工备注与核查标签、绑定和排除项，以及 reader／writer 的关系和时长汇总。核对文件身份时忽略 Notion 文件 URL 的临时签名与有效期，不把链接刷新误判为封面更换。

运行目录与项目维护目录中的私有配置需分别核对：确认来源一致后合并无冲突绑定、保留已有排除的并集，不以较新的绑定文件覆盖运行目录独有的排除规则。配置变化后重新采集及 dry-run；只读规划与使用真实读回状态的内存请求捕获不能称为实际 apply。Steam 独立隐私证据过期时保留失败结果，不改时间戳续期、不重放旧账户快照。用户当前实际核对完整客户端隐藏／私人名单并确认一致后，可以保存新的独立确认依据；原排除、产品分类和已核实范围保持，未核实产品继续跳过，新的确认仍受程序有效期限制。
