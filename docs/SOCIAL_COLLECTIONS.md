# B 站合集与详情批次

本阶段实现合集的本地模型、真实采集、更新判断和离线详情批次计划，并扩大现有社交作品的受限读取容量。网站合集投影、成员归属与逐项展示资格、云端上传协议扩展和 Claude 卡片接入仍是下一阶段；当前没有把合集伪装成旧的 `individual-video` 观测。

后续继续指令已实现独立合集上传与 [时间线 v2 扩展](SOCIAL_COLLECTIONS_CLOUD.md)，新增成员精确资格和成员折叠；旧 upload／网站接口仍保持。以下为本地阶段记录，云端实际安装／验收和 Claude 页面接入分别见新阶段记录。

## 一张卡的规则

`season` 是多个 BV 的合集；`multi-part` 是一个 BV 的多个 P。稳定键取平台、作者、类型和合集 ID，不含标题或代表视频地址。代表视频可以更换，卡片 ID 不变。同一合集每次刷新替换最新状态；历史留在本地，候选投影每个合集只有一张卡。

首次完整采集建立成员基线，不将历史成员报告成新增。后续比较曾见过的 BV 与已经证实完整的 CID 集合；统计变化、标题编辑、顺序变化、删除和删除后重新加入都不产生内容更新。新增 BV 不再同时计作新增 P，未知的 P 列表首次变完整也只建立基线。合集页只列出一个 CID、同时声明不明的成员分 P 完整性时，`partsComplete=false`，总 P 数为 null，不能据此推断没有其他 P。

发布日期、内容活动与采样时间分开：

- 合集创建／首次日期没有证据时 `firstPublishedAt=null`；多 P 保留原 BV 发布日期。
- `latestMemberPublishedAt` 是当前成员中可核实的最近发布日期，不代表加入合集的时刻。
- 新增成员有明确且晚于上一采样的发布日期时，`activity.basis=member-published`。旧视频新加入、日期未知或新增 P 没有独立时间时，实际更新时间仍未知，`latestAddition.publishedAt=null`；另存显式 `addition-detected` 检测活动，后续卡片只能标“发现合集更新”，不能称为平台发布时间。
- 统计、标题、代表视频和成员排序刷新保持 `activity` 及上一次 `latestAddition`，不改变内容排序依据；`observedAt` 仍是本次读取时间。既有 `SocialWork.occurredAt` 含义不变。

F37 增加可空 `dayAddition: { day, addedVideos, addedParts, basis }`：同日真正新增相加，`day` 按站点时区中 `activity.at` 归日，不取服务器今天。已知发布时间与发现时间分别归日，混合 basis 为 `mixed`；原 `latestAddition` 仍是最近一次增量。首次基线或历史不足返回 null，前端退回旧增量；计数回补不改排序及时间游标。

默认 `SOCIAL_COLLECTION_DAY_ADDITIONS=disabled` 兼容旧数据库。先安装 `20261019065657_social_collection_day_additions.sql`，经审核回补后再启用；原采集 payload 不变。冻结卡片只计已审核最近增量之前的证据，沿用撤回和 RLS。

本机准备：`node scripts/social-sync/collection-day-backfill.ts --plan /ABSOLUTE/PRIVATE/collections /ABSOLUTE/PRIVATE/output/plan.json --complete-local-history`。先核实保留完整采样；只读最多五百合集、每合集一万样本、合计 64MiB，输出到受保护目录，不连接云端。重放不匹配则记未知；受审管理员可用 `applyCollectionDayBackfill` 按来源摘要比较更新，来源变化则跳过，worker 无此写入权限。见 [F37 决策](decisions/2026-10-19-collection-day-additions.md)。

合集指标仅取匹配的 `season.stat`，收藏字段为 fav；多 P 仅读该 BV 的 stat 一次。口径分别为 `bilibili-season`／`bilibili-multi-part`，不累加单集或跨平台统计。零与未知分开，评论仅存数量。独立 [候选 DTO](../contracts/social-collections.ts) 不含作者 ID、成员明细、原始响应或凭据，未经链接核验时 `originalUrl=null`；尚未注册到现有 API 或页面。

## 本地入口

用同一 Node 24–26 程序，在外置 SSD 的独立 700 私有目录准备 600 的 `collection-config.json`，格式见 [虚构配置](../scripts/social-sync/templates/collection-config.example.json)。最多二十个明确指定目标；不自动发现账号所有合集，未支持 series 类型。代表地址必须为规范 BV 页面，返回作者、合集、成员作者、状态与统计身份逐项匹配；付费／限制、成员缺项、重复及过大输入整项失败。

```sh
node scripts/social-sync/cli.ts collect-collections /ABSOLUTE/PRIVATE/social-collections
node scripts/social-sync/cli.ts collections-status /ABSOLUTE/PRIVATE/social-collections
node scripts/social-sync/cli.ts collections-export /ABSOLUTE/PRIVATE/social-collections
```

独立 `social-collections.sqlite` 保存严格 schema v1 的最新状态、完整投影采样和匿名失败码，不迁移原 `social.sqlite`，不触碰其 outbox。更新事务原子；重复不增采样、旧样本不覆盖、同时间不同内容回滚。数据库与 sidecar 拒绝符号／硬链接、宽松权限和其他用户文件。每次 HTTP 最多十五秒；合集 SSR 页面固定上限 8MiB，单视频仍为 2MiB。声明长度及实际解码流均检查，超限取消读取，解析入口也按相同字节上限检查。只读取惰性 JSON，不执行网页脚本；作者、合集、统计归属、完整成员和投影上限仍需全部通过。串行间隔一秒、整轮两分钟；失败保留上次成功状态，退出非零，不以旧值冒充此次成功。

单合集最多一千个 BV、两千个已列 CID、512KiB 投影；历史最多一万个曾见 BV／两万个完整 CID，状态 2MiB。导出最多五百张候选卡、累计原状态 8MiB；超限明确失败，无静默截断。独立上传器加入后，`collection-candidates.json` 标 `cloudUploadSupported=true`／`websitePublicationApproved=false`，true 只表示有新的 upload-collections 能力。导出不是上传或公开；旧 ingest 明确拒绝新结构。本阶段不安装额外服务、周期任务或内置硬盘运行副本。

## 离线详情计划

`plan-details` 读取私有 `catalog.json` 与既有最多二十条的 `config.json`，生成 600 的 `detail-plan.json`，不请求平台、不创建数据库、不登记云端绑定。目录输入严格为：

```json
{
  "version": 1,
  "capturedAt": "2026-01-02T00:00:00.000Z",
  "complete": true,
  "accounts": [{"platform": "bilibili", "accountId": "10001"}],
  "entries": [{"platform": "bilibili", "accountId": "10001", "publicationId": "BV0000000001", "kind": "unresolved-video-card"}]
}
```

目录最多一千项／四账号，只接受指定账号、有效身份与已到末尾的清单。B 站主页的 `profile-video-card` 在经过目录验收后转换为 `unresolved-video-card`，进入 `COLLECTION_SCOPE_REQUIRED`，直到详情证实单稿件／合集归属；小红书图文和视频保留原类型。已配置来源跳过，`skippedConfigured` 不代表本轮采集或新鲜度通过。其余可采集项以稳定发布键排序，分成最多二十条且能通过现有配置校验的批次；作品关联键是待人工关联的候选，不猜测跨平台同作品。

```sh
node scripts/social-sync/cli.ts plan-details /ABSOLUTE/PRIVATE/social-collections
```

计划 `executed=false`，每批有稳定摘要标识，可以交给现有采集／浏览器入口执行，但当前没有自动执行、断点调度、逐项详情回执或整账号注册。小红书仍要求实际新鲜浏览器投影，不用目录时间代替捕获时间。

## 受限网站读取

原单稿件／笔记 reader 由一百扩大至五百件作品，每件仍最多二十个平台发布、每页最多二十。一次 SQL 在原 invoker／RLS 视图内选最多五百零一件作品，并在聚合前限制每件最多二十一条发布，利用多一项检测溢出。返回最多 8MiB，超限整页报不可用；不静默丢弃。首页混排同步采用五百上限，仍为完整来源快照、稳定游标及 24MiB 总预算。未更改角色、迁移、资格、新鲜度、TLS、缓存策略或开关。

## 实际验收与下一项

两个已授权真实合集各 147／26 集，新采集建立两张候选卡且不报告历史新增；不能证明所有成员 P 完整，总 P 数保留 null。两平台 243 条私有目录生成计划：五条已有配置跳过，132 条小红书详情分七批，106 条 B 站需确认范围；尚未把这 238 条收为完整详情。

下一阶段扩展云端合集投影和显式成员归属，确定合集与子视频去重及逐成员公开资格、检查实际跳转；再接统一读取与 Claude 的合集摘要。长期公开政策、全量详情执行、封面、平台登录持续运行和周期任务仍待验收。

后续云端与统一接口见 [合集云端说明](SOCIAL_COLLECTIONS_CLOUD.md)。新增私有基线、一个大合集的有界 SSR 实测及当前覆盖见 [本轮进度](progress/2026-10-12-social-large-collections.md)：本地 92 张合集／多 P 卡，云端 91 张，尚有一张只在本地排队；这些数量不表示已获网站展示资格。
