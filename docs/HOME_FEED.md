# 首页内容与社交混排接口（前端待接）

用户已选择保持分工：Codex 完成混排、分页与数据交接，Claude 接作品卡片。新增独立接口和 DTO，不编辑首页、组件、CSS、原时间线契约、共享 fixtures、依赖、栏目开关或冻结数据库协议。社交 reader 已验收，所有真实作品展示资格仍为空，见 [读取说明](SOCIAL_READER.md)。

## 入口与响应

服务端页面使用 `src/lib/content/home-feed.ts` 的 `homeFeedRepository.getPage({limit:16})`；客户端分页使用 `GET /api/home/feed?limit=16&cursor=...`。契约为 `contracts/home-feed.ts`。

响应 `{data:{items,total,hasMore,nextCursor,sources}}`。默认十六、最大五十项，仅接受 limit／cursor，非法、重复或未知参数 400。全部成功／错误 GET 响应为 private／no-store／noindex，无写入 HTTP 接口。原 `/api/timeline`、`TimelineEvent` 和页面行为保持。

- 内容项：`{id,source:"content",provider,occurredAt,event}`。event 完整沿用现有 TimelineEvent，动态正文和作品小卡数据保持。provider 为 mock／notion／database，mock 项须标出演示。
- 社交项：`{id,source:"social",provider:"database",occurredAt,work}`。work 是 SocialWork，一作品一项、各平台分别统计。provider 不是备用数据选择；真实社交源失败不能换模拟作品。
- id 为 `content:<event.id>` 或 `social:<work.id>`，适合 React key 和分页去重；不要使用数组序号。sources 明确本次两源模式，social=disabled 时不读取社交数据库。

F33 补充：游戏内容项的 `event.playedTime?: TimeAmount | null` 原样传递当前公开游戏的累计时长，单位及 null／0 保持；首批与后续分页均如此，v2 混排不增加逐游戏详情读取。前端可用现有 `cardTimeLabel(event.playedTime ?? null)` 显示，未知和零不写文字。该字段也用于原 `/api/timeline`；其他事件不带它。接口服务只提供数据，首页显示由 Claude 接入。

total 为获准内容事件数量加社交作品数量，不能用平台发布数量替代。已有内容去重／栏目和来源资格沿用原服务；不猜测 Notion 条目与社交作品的跨来源关联。

## 排序、版本与边界

每次请求各取得一次获准数据快照，之后统一排序／分页，不为混排循环读上游分页或逐条取正文。内容库沿用已有完整快照机制；Notion 直读仍有原采集成本，并不因此消除其全部延迟。身份握手另计，不把一次数据快照说成只有一次总 SQL 请求。两条读取链路各自一致，不是跨来源原子事务。

按站点时区的日历日降序；同日有具体时刻的先显示并按实际时间降序，纯日期随后，完全相同时按稳定 id 排序。纯日期不换成假造的午夜，日期字段原样保留；社交时间为 datetime，未知 null 最后。不同 UTC 偏移表示的同一时刻一致排序。

游标绑定两源版本、模式、时区和页大小，变化后 400／INVALID_QUERY，前端只重置首批，不反复重试旧游标。在 v2／retained 社交读取中，当前作品／平台发布集合、身份、日期、标题、合集成员数量或活动变化会改变社交分页版本；播放、点赞等统计、显示用近似数字、采样时间与链接核验时间不参与分页摘要。每页仍重新读取并校验当前资格和完整 DTO，返回当时最新统计，不缓存旧卡片。资格撤回／过期导致可读集合变化时，旧游标仍被拒绝。封面继续不参与分页摘要。旧 v1 社交读取保持原语义；内容版本沿用现有发布版本，不以每次媒体临时令牌变化制造新版本。游标与旧时间线／单独社交接口不能混用。任何启用源失败整体为 503，保留 RATE_LIMITED 供原交互显示忙碌；错误不泄漏 SQL、凭据或来源详情，不返回半页成功。

内容快照最多两万事件、社交快照最多五百作品，合并序列化上限二十四 MiB；超限明确失败，不截断。社交 SQL 投影另有 8MiB 预算，见 [合集阶段的读取扩容](SOCIAL_COLLECTIONS.md#受限网站读取)。没有全量快照 HTTP 接口；这些上限沿用原 provider 和社交域的服务器边界，不表示无人值守、所有账号历史或大规模性能已验收。

## Claude 接入位置

1. 首页 Recent 的首批调用换为 homeFeedRepository；HomeTimeline 初值使用 HomeFeedPage，`usePagedList<HomeFeedItem>` 的 endpoint 换为 `/api/home/feed`，保持十六项页大小与已有 INVALID_QUERY 首批重载逻辑。
2. source=content 时把 item.event 交给已有动态／作品渲染，保留已有文档展开与媒体资格路径。source=social 才使用新的作品卡片；日期／月份从 item.occurredAt 派生，可让已有 eventMoment 接受这一最小日期结构。
3. 一张社交卡片用 work.id／title，各 platform 发布分别展示指标。exact 的 null 是未知、0 是真实零；display=1.2万 的 exact 仍 null，不能相加成精确热度。评论只显示数量，非空 originalUrl 才给原平台跳转，注明原平台可能要求登录；缺链接、日期或封面不补猜。当前 cover 为 null。
4. 根据每项 provider 标记演示，避免把内容 mock 与真实社交混排时统称为真实内容。仅更新页面接入不自动开启 SOCIAL_PROVIDER 或批准作品；真实展示范围仍需另行选择。

卡片视觉与交互本轮没有实现。前端可用 `tests/helpers/home-feed-samples.ts` 的虚构样本做自己的组件测试；它没有注册到产品 provider，也没有改共享 fixtures，不能导入生产数据入口。案例覆盖一作品两平台、真实零、未知和近似显示、无日期／封面／链接。不要把忽略目录中的真实回读复制到公共 fixtures。

本轮验证包括跨来源多页无漏项／重复、日期精度与时区、跨源 ID 冲突、版本／模式变化、失败不回退、参数与错误脱敏、每源一次读取以及 reader 原回归；实际 HTTP／云端只读边界和构建结果以 [进度](PROGRESS.md) 为准。未改真实公开资格、凭据、Supabase SQL 权限、Vercel配置、部署或调度。
