# 图片预览副本

列表和图片网格请求宽度上限 400px，较大封面和全部可读正文先请求 800px，保留比例且不放大小图；点开灯箱再使用原图入口。此规则包含影视、书籍、游戏、相册、课程／学习笔记、关于、博客、项目和动态展开正文，取代学习正文默认原图的旧规则，见[正文小图决策](decisions/2026-10-14-body-image-previews.md)。原图仍按 [混合媒体方案](HYBRID_MEDIA.md) 从 Notion 动态地址、既有外链或转换对象读取。预览为独立 WebP 对象，保存到 Supabase **私有 Storage**；PostgreSQL 只登记描述符、来源身份和批次。

## 覆盖选择与真实接入

离线覆盖选择器对每个启用栏目遍历已提供的正文 AST，提取真实图片节点并加入 800 档；嵌套列表、callout、折叠和分栏同样处理，不跟随子页面链接、提及、嵌入或普通文本 URL。影视／书籍／游戏等封面选择 400／800，相册封面及网格图片也选择两档。动态列表仍只给前九次图片出现选择 400，完整正文中的其余图片选择 800；同一资产合并所需档位，不重复登记。直接外链只记录为外链，不伪造受管资产或自动下载。缺失与部分正文分别报告，不能称全覆盖。

此选择变化只准备候选，不扩大公开资格、执行预算或正在运行的固定包。既有只包含封面的 inventory 不包含全部正文图片，需要从同次 accepted 工件及缓存重新盘点；不能用原固定 197 项或新封面集合充当正文全覆盖。生成、对象独立回读、同批次登记与网站实际命中分别交回，缺映射和无体积收益使用获准原图；权限、来源或对象校验错误仍明确失败。历史验收中“学习正文原图”描述原验收行为，不再是当前产品规则。

## 编码与登记

编码器先校正 EXIF 方向、转换到 8bit sRGB，再缩放。每档比较 WebP quality=85、alphaQuality=100 与无损 WebP，选择体积更小的候选；透明度保持，输出不携带源 EXIF。无损候选相对于缩放后的参考像素无损，缩小图片本身仍会损失原图细节，不能把预览称为原图的无损替代。

新增预览按档位核对体积：只有候选字节数严格小于当前原件字节数，才预扣上传额度、上传并登记。相等或更大的候选不建立映射，仍使用经过资格检查的原图入口；400px 有收益而 800px 无收益时，只登记 400px。原件读取和编码仍消耗各自预算，不能把跳过上传当作零成本。报告的 `notSmaller` 按无体积收益的档位计数，`skipped` 继续只计编码器明确跳过的原件。已有映射仍按原规则验证读取，不因新规则删除或改写。

单张输入上限 20MiB、40MP；各原生操作默认超时 30 秒，最长 60 秒，不等于整个批次的总超时。动画、多页和高位深原件明确跳过，继续使用原图。损坏图片、尺寸越界和读取失败明确终止。批次串行、最多 20,000 个不同资产、累计下载原件上限 1GiB。批次只处理操作员明确选择的当前发布代次，不遍历 Notion 全库。

原图的 `assetId`、SHA、DTO 和冻结核心 SQL 不变。独立索引以内容版本、runId、原图资产与宽度档位为键，核对当前发布资格、原图 SHA、来源指纹及 owner。派生对象使用输出 SHA 地址，不覆盖既有对象；相同对象可复用，不同输出不能覆盖已有映射。上传成功后须实际读回并校验，再登记。中途失败可能留下私有对象或已完成映射，原批次仍有效时可重跑；没有自动删除或垃圾回收。

## 独立命令

需要 Node 24 和开发依赖。各环境、来源及计划文件使用绝对路径、当前用户所有、600 权限，状态目录 700。命令只输出匿名计数，密码与 Token 不得放进参数。迁移与生成由操作员在既有独占维护窗口运行；本命令的状态锁只排斥使用同一状态目录的缩略图任务，不能代替全站 worker 的维护锁。受限 writer 会话刷新也须沿用既有串行守卫。

```sh
npm run media:protocol
npm run media:thumbnails -- migrate --env /ABSOLUTE/PRIVATE/admin.env
npm run media:thumbnails -- run \
  --env /ABSOLUTE/PRIVATE/writer.env \
  --reader-env /ABSOLUTE/PRIVATE/reader.env \
  --plan /ABSOLUTE/PRIVATE/thumbnail-plan.json \
  --budget /ABSOLUTE/PRIVATE/budget/execution-budget.json \
  --state-dir /ABSOLUTE/PRIVATE/thumbnail-state
```

迁移环境提供 `DATABASE_MIGRATION_URL` 与明确的 TLS/CA 配置。独立迁移先核对已安装核心及登记摘要，在同一事务安装独立 schema、权限及其摘要；错误或半安装状态拒绝继续。先安装对应版本的混合媒体扩展；迁移不安装核心、不设置政策、不发布或延长内容 TTL。

生成使用 reader 环境的 `DATABASE_READER_URL` 读取资格，writer 环境的 `SYNC_DATABASE_URL` 登记，二者使用独立连接。操作前核对两者 host、端口、数据库与共享 Supabase pooler 用户名项目后缀一致；角色和密码可以不同，不同连接模式须先统一，不能仅凭相同 runId 推断为同一数据库。writer 同时提供当前版本 Notion 来源配置、只读 Notion Token 与受限 `STORAGE_WRITE_TOKEN`；Storage 权限沿用原私有桶。无 service-role 凭据。相同键若在两个环境中都有配置，Storage 端点与 TLS 配置必须一致。本机隔离验收也可用既有 `DATABASE_MEDIA_DIRECTORY` 适配器。连接身份格式见 [Supabase 官方说明](https://supabase.com/docs/guides/database/connecting-to-postgres)。

进程被中断或强制结束可能遗留缩略图状态锁。先确认该进程已退出，再用既有安全解锁命令；它核对 PID 不存在及锁 inode 一致，不读取环境或重跑同步，不能手动删除仍有活进程的锁：

```sh
node scripts/notion-sync/cli.ts --state-dir /ABSOLUTE/PRIVATE/thumbnail-state --unlock-stale
```

计划只允许三个字段，以下均为虚构示例：

```json
{
  "version": "v2",
  "runId": "11111111-1111-4111-8111-111111111111",
  "assetIds": ["a1.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]
}
```

实际 runId 与资产必须来自当前已发布且仍具资格的批次。更换发布代次后旧映射不会自动沿用，需对新批次重新登记；对象字节可复用。生成器不会续租、更新发布时间、恢复撤回记录或触发完整同步。当前没有接入定时 worker，后续调度任务须在完整发布后另行串行调用。

`run` 在独占的缩略图状态目录保存 `verified-thumbnails.json`（600，目录 700）。这是私有字节定位清单，不是公开资格或完成发布的证明。它记录本程序在实际读回、登记并再次核对当前来源后完成的小图，按编码版本、原图身份／SHA、owner、来源指纹、完整绑定和档位匹配，不按 runId 匹配。原图未变但内容进入新批次时，程序先检查新批次的 reader 资格和 live 来源，再读回旧小图校验，最后为新批次登记；这条路径没有原图下载、重新编码或 Storage POST，仍有小图回读和来源请求，不能称为零流量。

新增或变更图片按原流程生成；编码配方或原生库版本改变时不复用旧配方清单。已登记但没有编码配方依据的历史映射仍正常验证和读取，不自动写入新清单，首次跨批次可能需要重建一次。清单缺失时按正常生成流程运行；清单损坏、权限错误、进入复用的候选对象丢失／校验失败或来源撤回时明确停止，不能把错误当作缺图重新上传。清单最多 20,000 个来源／40,000 个档位条目、32MiB，不自动删除云对象；保留状态目录及其备份才能保留跨批次复用能力。

只有小于当前原件的清单候选才进入实际回读与复用。有效描述符若相等或更大，按缺少可复用候选处理，重新读取并核验原件、编码和检查来源，不以清单决定跳过；这条路径不试读被排除的旧对象。旧清单条目保持不可变，若重新生成较小图仍可登记到当前批次，但不覆盖该旧条目。清单格式损坏仍明确失败；进入复用的较小对象读回失败、权限错误或来源撤回也继续失败。

完整成功前原子保存清单；部分批次失败时也尽量保存已完成且通过最终来源检查的条目，退出状态继续为失败。清单持久化失败不会输出完成。强杀或断电仍可能丢失尚未落盘的候选，随后按当前 SQL 映射和现有重跑规则恢复。这个本地复用能力没有自动选择图片、安装周期任务或接入内容发布 hook；实际扩大覆盖需要按当前资格另做有预算的分批计划。

## 离线覆盖盘点与分批提案

`scripts/media-thumbnails/plan-cli.ts` 是独立离线入口，不读取环境文件、连接数据库、请求 Notion／Storage、下载原图、编码或上传。操作员先用受限 reader 导出当前获准的 `PublicContentSnapshot`（包含正文）及每个候选资产的两档 `nb_thumbnail_api.read_media` 原始返回，再传入已经允许的栏目和预算。导出只证明当时的 SQL 投影，未检查 live 来源或实际对象字节；执行前仍须重新核对当前批次、来源与维护窗口。

选择规则：动态前九次图片出现使用 400 档，完整正文图片全部选择 800 档；动态独立封面为 800 档。相册封面与网格图片选择 400／800；作品库、博客、项目封面为 400／800，课程封面为 800。所有启用栏目的正文，包括学习笔记与普通页，遍历已加载 AST 选择 800，灯箱继续使用原图。不沿子页面链接寻找图片，不扩大栏目或公开范围。DTO 中的直接 HTTPS 外链保持原 URL；已经登记为 `/media/…` 的资产可成为候选。未加载正文与部分正文分别计数，不能据此宣称所有潜在图片已盘点。

输入清单格式为 `notionblog-thumbnail-inventory-v1`，包含 `version`、`runId`、`snapshotVersion`、`qualifiedAt`、`validUntil` 和 `cells`；每个候选恰有两格 `{assetId, widthCap, result}`。`result` 使用正式 reader 返回的完整 envelope；整个返回为 null、跨批次、来源／owner 不一致或畸形映射都失败，只有通过验证的 `thumbnail: null` 表示该档缺图。规划阶段不把登记元数据当成对象字节验收或编码配方依据。

```sh
node scripts/media-thumbnails/plan-cli.ts \
  --snapshot /ABSOLUTE/PRIVATE/snapshot.json \
  --inventory /ABSOLUTE/PRIVATE/thumbnail-inventory.json \
  --options /ABSOLUTE/PRIVATE/planning-options.json \
  --output-dir /ABSOLUTE/PRIVATE/new-proposals
```

三个输入为 600 文件，所在目录及输出父目录为规范路径、当前用户所有的 700 目录。输出目录须不存在或为空；文件不覆盖既有提案。快照／清单各最多 32MiB，选项最多 2MiB。以下预算是虚构配置示例，不是云端执行授权：

```json
{
  "enabledKinds": ["status", "course", "study-note"],
  "limits": {
    "maxParents": 3,
    "maxOriginalBytes": 67108864,
    "maxUploadRequests": 6,
    "maxUploadBodyBytes": 2097152,
    "maxDurationSeconds": 480,
    "maxTotalParents": 15,
    "maxTotalOriginalBytes": 134217728,
    "maxTotalUploadBodyBytes": 10485760,
    "maxTotalDurationSeconds": 2400,
    "eligibilityReserveSeconds": 120
  }
}
```

输出包含私有覆盖报告、每批三个字段的 `plan`、对应的 `widths` 尺寸清单、每批预算和最后写入的 SHA 完成标记；整体以临时目录原子安装。完成标记明确 `proposalsOnly: true`、`executionAuthorized: false`，控制台只有匿名数字。提案按原图字节由小到大选择，原图预算按不同资产逐件累计，不能用跨 owner 的 SHA 去重节省实际生成器可能重复下载的流量。已满足界面所需档位的资产不再入选；新版提案的 POST 上界只计算界面所需的缺失档位，执行时必须同时传入对应的 `--widths` 文件；省略该参数的旧命令仍处理两档，不能沿用较小的提案请求上界。复用缓存没有在提案中扣减，必须实际核对缓存、对象和新批次后才能确认节省量。

每批分别约束父图数、原图读取量和潜在 POST 数，并为整轮预留完整上传体积与时间上限；资格剩余时间不足时不继续排批。超限和本轮未选择的父图列为待处理。上传后的实际字节、新对象体积和实际耗时均保留 null，不能从几张样本外推全站，也不能把原图大小当成 WebP 大小。

规划输出仍不能直接交给循环脚本执行。`run` 要求另一个严格的执行预算文件与已经初始化的累计账本，不接受这里的单批预算文件替代它们；执行前重新检查来源资格，确认新的执行额度与独占维护窗口。既有云端小批的累计 POST 额度不会因生成新计划或新状态目录而重置。离线入口不接入 worker、发布 hook 或定时任务，不续租已发布内容。

## 本机原图复用与按需尺寸

`run` 新增两个可选参数：`--originals-dir` 指向本机原图的 SHA 文件目录，`--widths` 指向该批的私有尺寸清单。三个字段的原计划、冻结 SQL、网站 DTO、开关和编码配方保持兼容；旧命令省略两参数时沿用网络原图与两档处理。

尺寸清单使用 `notionblog-thumbnail-widths-v1`，包含 `format`、`version`、`runId` 和 `assets`。每个元素为 `{assetId, widthCaps}`，档位只能是非重复的 400／800，必须恰好覆盖原计划中的资产和批次。清单只收窄原计划已允许的两档，不增加资产或额度；离线提案自动保存 `batch-NNNN-widths.json`，摘要也写入完成标记。现有映射及较小的合格编码缓存继续按所选档位验证复用，仅对缺失档位编码、上传和登记，不读取无关档位。

原图目录必须是规范绝对路径、当前用户所有的 700 目录；文件名必须为当前源 SHA，文件为当前用户所有的 600 普通文件，不能是符号链接或多重硬链接。读取逐张核对实际长度、MIME、SHA 及读取前后的文件／目录身份，单图最多 20MiB；仅元数据匹配不算原图已验证。缺失、损坏、权限错误、来源变化或撤回都失败停止，不转成网络重下载。启用镜像不会创建目录、扫描全库或修补坏原件。

原图读取仍在 I/O 前预扣现有原图字节额度，失败也不退费；实际使用时读取一次，已有合格小图不再读原图。镜像只替换原图输入，派生图仍使用原来的 Storage 适配器进行不可变写入及读回。SQL 当前批次、资格和 live 来源检查照常执行，因此原图下载可以为零，但不能声称整批零网络或零 Supabase 出站。

```sh
npm run media:thumbnails -- run \
  --env /ABSOLUTE/PRIVATE/writer.env \
  --reader-env /ABSOLUTE/PRIVATE/reader.env \
  --plan /ABSOLUTE/PRIVATE/batch-0001-plan.json \
  --widths /ABSOLUTE/PRIVATE/batch-0001-widths.json \
  --originals-dir /ABSOLUTE/PRIVATE/originals/sha256 \
  --state-dir /ABSOLUTE/PRIVATE/thumbnail-state \
  --budget /ABSOLUTE/PRIVATE/allowance/execution-budget.json
```

这些入口不授权新的云操作，不重开旧账本、不安装周期任务、不发布或续期内容。真实首批仍需当前资格、新的明确额度与维护窗口；本机合成图片验证不代替实际上传或国内访问验收。

## 执行预算与累计账本

执行预算使用 `notionblog-thumbnail-execution-budget-v1`，绑定 `budgetId`、内容版本、runId、获准计划的 canonical JSON SHA 白名单，以及每次尝试和整轮上限。它只能约束一次已获准操作，文件或账本不授予来源资格、维护窗口或新增云端上传额度。旧六次 POST 的实际账本继续保留，不能用新预算目录或离线初始化命令重建成零；更大范围的提案仍须先确认新的额度。

以下结构和身份均为虚构示例。`planSHA256` 必须是 `thumbnailPlanDigest(plan)` 的实际结果，而非原文件排版字节的 SHA：

```json
{
  "format": "notionblog-thumbnail-execution-budget-v1",
  "budgetId": "11111111-1111-4111-8111-111111111111",
  "version": "v2",
  "runId": "22222222-2222-4222-8222-222222222222",
  "planSHA256": ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
  "limits": {
    "maxParents": 3,
    "maxOriginalBytes": 67108864,
    "maxUploadRequests": 6,
    "maxUploadBodyBytes": 2097152,
    "maxDurationSeconds": 480,
    "maxTotalParentAttempts": 15,
    "maxTotalOriginalBytes": 134217728,
    "maxTotalUploadRequests": 30,
    "maxTotalUploadBodyBytes": 10485760,
    "maxTotalReservedDurationSeconds": 2400
  }
}
```

预算文件为规范绝对路径的 600 文件、父目录 700。预算目录必须与缩略图 `state-dir` 不同，固定账本 `thumbnail-execution-ledger.json` 保存到预算文件旁，持有独立进程锁；更换缩略图缓存／状态目录不能改变这份累计费用。预算锁持续持有创建时的文件句柄并核对完整 nonce／内容，防止 Linux 复用已删除锁的文件编号而误删替换锁；现有 `--unlock-stale` 格式保持兼容。只有新额度经过确认后，才显式离线初始化一次：

```sh
npm run media:thumbnails -- budget-init \
  --budget /ABSOLUTE/PRIVATE/budget/execution-budget.json
```

初始化不读环境文件或连接云端，已有账本拒绝替换。`run` 缺少预算／账本、计划未入白名单、预算变更、账本损坏、权限错误或活跃锁都在外部操作前拒绝；不能把丢失账本当作首次运行重新初始化。账本验证累计总数与每次尝试之和，逐次原子同步保存，保存失败禁止开始对应请求。

每次尝试开始时，先预留整个计划的父图尝试数和完整时限额度；成功、失败和提前结束都不退这两项。这是保守预留，不是实际耗时统计。缺小图而需要原件时，再按源描述符的字节大小预扣原图读取额度，下载器的单图上限收紧为该值，最长仍为 20MiB；原件读取中断或拒绝也不退费。上传前以实际已编码字节同时预扣 POST 次数和请求体大小；不可变对象冲突、网络错误或不确定结果仍计费。已验证映射／编码缓存复用不发 POST，但仍可能发生来源、对象与 SQL 请求。

仅复用已有小图的计划可将 `maxOriginalBytes`、`maxUploadRequests`、`maxUploadBodyBytes` 及对应三项 `maxTotal...` 设为 `0`；父图尝试数与时限仍须为正整数。符合当前源和编码配方的缓存继续读取小图验签并登记，原图读取与上传预留保持为零。若选中档位没有可复用小图，需要读取原图时会在 I/O 前被零额度拒绝，停止整个尝试；不会自动改为下载、编码或上传。未发生的图片 I/O 不计入图片额度，但已经开始的父图和时限预留仍保留。零图片额度不代表零网络流量，Auth、Notion、SQL 和小图回读仍须单独约束，也不授权新批次发布或资格续期。

累计额度包含重试和各白名单批次的每次尝试，达到任一上限就失败停止，不自动扩额或重置。这里计的是原图读取预留和上传请求体，HTTP 头、错误响应、对象回读、Auth、Notion 等不在该字节额度内，不能称为实际出站账单上限。底层批次函数的注入式测试接口仍允许没有预算；生产命令行 `run` 强制预算，不提供跳过选项。

整批截止采用单调时钟，普通停止与硬截止使用独立通知，失败收尾也受同一截止约束。原图下载及固定 Storage／Notion 传输收到取消信号，SQL／来源检查、原生编码和副作用的前后均核对截止时间；Notion 保留共享调度与 cooldown，在途 HTTP 另有九秒界限，不把它称为包含排队的九秒总时限。命令行入口在截止时先同步输出固定失败，再用 SIGKILL 强制结束自身进程；普通 `process.exit` 在系统线程阻塞时可能等待，不能用它保证原生工作硬停止。信号退出为失败，只处理本 CLI 的 PID，普通额度耗尽继续正常失败收尾，尽量保存已完成缓存。

硬终止可能留下状态目录和预算目录的锁，或尚未落盘的缓存候选；已经预扣的费用不会因此消失，在途 SQL 也可能留下需读回确认的登记。先确认进程已退出，再分别用前述 `--unlock-stale` 解锁两个目录，恢复原账本后重试；不删除账本或强行抢活跃锁。嵌入式调用 `thumbnailCommand` 或批次函数只负责协作取消／前后检查，不自行终止宿主，调用方须提供自己的硬截止机制。

## 网站开关与退回

小于400／800档位的原图也会按原尺寸尝试WebP，不因为不缩放就一律跳过；`withoutEnlargement`只限制放大。实际变体不小于原件时保留原图，JPEG变体采用现有质量85配方，不为小JPEG默认降至75；详见[F19决定](decisions/2026-10-17-f19-media-repair.md)。编码拒绝应记录为待跟进的例外，和无体积收益、动画等预期保留原图分开说明，不能仅核已登记集合就宣称全站覆盖。

网站保留 `CONTENT_PROVIDER=database`、`MEDIA_PROVIDER=notion`、匹配的 `DATABASE_CONTENT_VERSION` 及服务端来源配置，完成迁移、当前批次登记和 reader 权限检查后设置 **`MEDIA_THUMBNAILS=enabled`**。默认 `disabled`，旧站点仍使用原图。预览入口为 `/media/a1.…?thumbnail=400` 或 `/media/v2/a1.…?thumbnail=800`，仅支持这两个档位。

每次读图都检查原图当前资格、批次和 live Notion 来源；对象下载后再检查，返回 `private, no-store` 的已验证小图字节，不生成公开桶或长期签名地址。明确没有该档映射时才使用原获准入口；权限、SQL、来源和对象校验错误不静默回退。撤回或来源变化拒绝返回旧小图。

恢复 `MEDIA_THUMBNAILS=disabled` 后，本机需要重启读取配置的服务；Vercel 需要部署新的受保护 Preview，并核对该部署的原图 HTTP、认证保护和 noindex。环境变量变更不影响已有部署，见 [Vercel 官方说明](https://vercel.com/docs/environment-variables)。若新部署被配额阻止，旧部署仍保留原开关，不能声称已经回退。无须搬迁或删除对象。外部图片 URL 若直接存在于 DTO 中则保持原 URL；经同步登记的 Notion／外链资产才可生成副本。切换整个图床另见混合媒体说明。

## 本轮验收与局限

- 后续真实接入：在独立 PostgreSQL 16 实例中，重新严格采集三个既有获准样本页，形成三条内容、15 个图片引用／14 张去重原图、42,403,791 B 的新 v2 批次。仅这个样本使用正常一小时资格，不复制或延长已过期的全量批次。冻结核心／媒体与独立缩略图迁移按摘要安装，reader／writer 为不同受限登录；原全量库在采集前后和 HTTP 验收结束时的只读归档数据摘要一致；该摘要不涵盖全部数据库 catalog。
- 新批次选择三个真实父图，两档共六个新私有 WebP 对象 **446,232 B**。生产生成器上传读回后登记；独立 Storage reader 的实际 SHA、大小、HTTP MIME 和解码尺寸通过，匿名及 public 路径各六次拒绝。再次执行六档全部为已存在映射，新增登记和上传均为零。原图沿用 Notion 动态交付，原件上传为零；本次没有安装云端 v2 或云端缩略图 SQL。
- 正式本机媒体路由的 23 项检查通过：六档 200／WebP／SHA／尺寸／安全响应头，三原图 302 后有界下载并校验 SHA／大小，缺映射的获准原图、非法宽度、未知资产、reader 禁登记／读私表与 writer 禁读投影。真实 Storage 读完后，由另一条 PostgreSQL 连接撤回 owner，生产响应模块返回 404、没有原图回退；随后真实 HTTP 的原图与两档均 404。只在自有数据库清除测试撤回，再复验 200／302。
- Chrome 使用正式页面和当前真实父图：作品列表实际解码 400px 小图，详情请求 800 档（小原图不放大）；相册正文实际解码 400px，点击灯箱读取 4169×2985 原图，Escape 关闭并返回原按钮。应用控制台警告／错误为零。仅检查实际加载的代表图，不声称相册所有屏外图或全站逐图已验收。真实预览启动器已保留 `MEDIA_THUMBNAILS`，仍过滤 owner／writer 配置并强制 loopback／noindex。
- 真实 Storage：照片、小字和透明图各一张、两档，共六个新对象 **185,948 B**；独立 reader 读回的 SHA、字节、WebP MIME、尺寸、RGBA 与透明度一致，匿名与 public 路径各六次均拒绝。使用合成验收身份，尚未给云端当前正文批次登记真实父图映射；不代表网站已全量启用。
- 隔离浏览器：真实 ContentImage／Lightbox 与媒体响应模块、虚构资格和本机对象传输；实际解码 400×300、800×600，学习正文和灯箱均 1200×900 原图，控制台无警告或错误。临时路由和页面已移除，正式路由恢复。
- 自动验证另覆盖实际 PostgreSQL 语义的 PGlite 核心、受限角色、索引、生成与 HTTP 响应贯通；Notion live 资格与对象传输在这些测试中为明确模拟。与最新 develop 整合后，719 项测试、类型／协议／隐私检查及生产构建通过，35 份服务端追踪排除私人运行文件。真实 PostgreSQL 双连接撤回竞态已由上述新样本补验；云端 SQL／完整批次、国内网络、Safari 和手机尚未实测。

以上字节数是对象内容与读回负载，不能当成 Supabase 账单或整月出站用量；Auth、错误响应和服务传输开销不在该数字内。缩略图开关默认仍为关闭，本机样本与私有 Storage 成功不等于正式站点启用。下一步由云端 v2 当前批次的负责人先完成获准的发布与预览，再在独占维护窗口安装匹配的缩略图扩展、登记该新代次并小批启用；不能用过期批次或恢复归档替代新资格，不与完整同步争用 writer 会话。


## qualified v2 小图与原图分开存储

`MEDIA_PROVIDER=notion` 的 v2 网站可设置服务端 `THUMBNAIL_STORAGE_PROVIDER=cos`，只把已登记小图交给受限 COS reader 读取；`STORAGE_PROVIDER` 继续决定 HEIC 等转换原图的存储。不设置新选项时继承原存储选择。普通原图仍使用原有 Notion 资格检查和动态地址。

新选项不改变 published 模式、v1 媒体、来源公开范围、批次有效期或浏览器 DTO。每次小图响应仍先后检查当前数据库映射与 Notion 来源，再核对对象字节。缺少登记沿用原图；已登记小图仅在已分类的临时网络连接／请求超时后，可重新检查当前映射并进入现有原图资格路径；不复用旧签名URL、不改读其他图床、不自动重试COS。数据库／Notion资格失败、证书错误、对象403／404、未知错误和字节校验失败仍明确拒绝。小图必须在所选存储完成独立回读且登记到当前批次后，才能启用对应部署；仅上传完成不能宣布上线。云端配置和生产发布仍需具体执行批准。

数据库小图资格的显式候选见[读取可靠性决策](decisions/2026-10-17-media-read-reliability.md)。默认继续实时Notion资格；候选将小图源端变化传播时机与页面对齐，中央下架和下载前后数据库检查保留，正式启用需要明确接受该语义。

COS可用`COS_READ_TRANSPORT=native-https`选择网站原生只读连接，`COS_READ_ENDPOINT=accelerate`选择同桶全球加速读取地址；两者默认分别为fetch／regional。后者要求先独立批准并启用桶的付费加速，代码不会操作桶。writer及普通原图provider保持原配置；全球加速关闭时不可宣称此路径可用。已登记v2小图可另行显式选择数据库资格以避免正常命中的Notion请求；原图回退仍可能限流。详见同一[读取可靠性决策](decisions/2026-10-17-media-read-reliability.md)。


## 可选课程封面 1600 档

课程顶部封面可请求 `/media/v2/a1.…?thumbnail=1600`，实施决策见[课程大档](decisions/2026-10-17-course-cover-1600.md)。这是独立 opt-in；省略尺寸清单的生成、全局覆盖盘点和正文依旧使用原有 400／800，不自动多生成第三档。`planCourseCoverThumbnails` 从同一快照只选择课程封面，输出明确的 v2 plan 与 `[1600]` widths；小于 1600 或未知尺寸的原件不进入新档生成，缺少映射时使用合格原图路径。直接外链保持原 URL。

1600 需要独立迁移，旧迁移字节不变。`npm run media:thumbnails -- verify-course-covers` 只校验本机 SQL 摘要；获准的操作者以后可执行 `npm run media:thumbnails -- migrate-course-covers --env /ABSOLUTE/PRIVATE/ADMIN.env`。迁移要求已安装原小图索引和 last-success 扩展，并核对三段原函数定义；新增私有扩展登记、放宽 v2 的宽度约束、替换原 reader 与内部登记实现，保持外层有效期守卫、当前批次、父 SHA／fingerprint、不可覆盖和权限。1600 只允许当前课程 item.cover 对应的 cover 资产，不适用于正文、其他栏目、冻结 v1 或尚未启用的 published 读取。

缺少新映射时，普通原图可能 302，转换后 Storage 原图可能 200；不得把原图回退记作小图命中。源图不足 1600 时不放大；1600 编码保持现有配方，宽度参与身份／缓存键，不重做旧 400／800。新对象仍须小于原件并独立回读。

先部署支持、完成有效批次登记和代表读取，再启用课程页。使用 `800w,1600w` 与实际 sizes 时，显示宽度超过 800 的一倍屏也可能选择 1600；小图失败回原图时须一起清除 srcSet，灯箱仍用原图。未来每批须按新资格再绑定；保留上次成功内容的读取不允许过期新增登记。当前本项只批准生成／上传，未批准生产迁移、发布或恢复同步。


## 访客浏览器缓存一天（F17）

用户接受撤回前已看到的图片可在自己的浏览器继续保留最多一天。成功且校验后的v2小图（400／800以及获准1600）、站内直接返回的v2原图、社交封面原图／小图使用`Cache-Control: private, max-age=86400, must-revalidate`；`CDN-Cache-Control`和`Vercel-CDN-Cache-Control`均为`no-store`，不放行共享缓存。平台可能消费自己的专用头，实际浏览器不一定看到它。

不加immutable：父图摘要地址可跨发布重绑，派生配方与资格并不保证永远不变。过期必须重新验证，不使用stale-if-error。缓存时效是浏览器响应的新鲜期，浏览器可提前清缓存或按用户刷新指令重新请求，不能声称一定每次命中。

只改成功的字节响应；无资格、未找到、异常及Notion动态地址的302跳转仍no-store，避免缓存过期的签名Location。上游直连图片自身缓存头不由站点控制。服务端对每个到达的新请求继续做原来的资格／下载后撤回检查；撤回无法删除访客已有副本，fresh浏览器命中期间不会来服务器重新检查。冻结v1维持no-store。网站内容同步仍由原调度管理，本项不恢复它。
