# 作品页平台、年份筛选与排序

`/api/social/works/v2` 与服务端 `socialTimelineRepository.listWorks` 共用 `SocialWorksQuery`。默认一页 12 条，最多 20 条。HTTP 返回 `{data:{items,total,hasMore,nextCursor,yearCounts}}`。前端为默认 B 站显式传入 `platform=bilibili`，省略 `platform` 时两平台合计。

## 参数

| 查询 | 行为 |
| --- | --- |
| 不传platform/order | 全部作品，按作品页发布日期降序 |
| `platform=bilibili` | B站作品，按日期 |
| `platform=xiaohongshu` | 小红书作品，按日期 |
| `platform=bilibili&order=views` | B站按精确播放量降序 |
| `platform=xiaohongshu&order=likes` | 小红书按精确点赞量降序 |
| `platform=bilibili&year=2025&order=views` | B 站 2025 年作品按精确播放量降序 |
| `platform=xiaohongshu&year=2025&order=likes` | 小红书 2025 年作品按精确点赞量降序 |
| `year=undated` | 仅取发布日期未知的作品，可叠加平台和排序 |

`year` 接受 1 到 9999 的整数或 `undated`。选全部年份时省略 `year`，按发布日期时省略 `order`。不带platform的order、小红书views、B站likes、`order=time`、未知值、重复参数、未知参数以及不合法的year/limit/cursor均为400 `INVALID_QUERY`。禁用仍404；真实reader失败仍503，不回退演示数据。响应保持 `private, no-store` 与 `noindex, nofollow`。

数字未知排在真实零后；同数按作品页日期降序，日期未知最后，最终按作品ID字节顺序打破并列。合集直接用合集总统计；普通作品只加总首要平台的精确值，一条未知则总值未知，超出安全整数也不造近似整数。小红书“1.2万”等显示文字仍保留，不能拿来猜精确排序数。

## 首要平台与日期

同一作品只归一个平台：合集归B站，普通作品包含B站发布则归B站，否则归小红书。此规则与发布数组顺序无关，不拆分统一作品ID，不把另一个平台的统计相加；完整publications仍保留。筛选后total按这个规则计算，两平台合计等于全部作品数。

前端可直接使用无服务端依赖的公共辅助函数：

```ts
import {
  socialWorkPlatform,
  socialWorkPublishedAt,
  socialWorkMetric,
} from "@/lib/content/social-works-query";
```

- `socialWorkPlatform(work)`：卡片所属平台。
- `socialWorkPublishedAt(work)`：本次排序、年份分组和卡片日期的唯一日期规则。合集取 `collection.latestMemberPublishedAt`；普通作品取首要平台中最新的 `publication.publishedAt`。缺失保持null，不以occurredAt编辑日期或observedAt采样时间替代。年份按站点时区转换。
- `socialWorkMetric(work, "views" | "likes")`：首要平台精确统计；页面仍按相应平台显示指标。

合集的 `activity.at` 可能是“发现新增”的时刻：当新增成员发布日期未知时，`activity.basis=addition-detected`，该值不等于最近一集发布日期。作品页“最后更新”和分年用上述publication规则；首页继续原activity混排与显示逻辑，不改F22及首页新增视频文案。单件日期也不把跨平台较晚的转载日期当首要平台发布日期。

## 首屏、后续页与游标

```ts
import { socialTimelineRepository } from "@/lib/content/social-timeline";
import { parseSocialWorksQuery } from "@/lib/content/social-works-query";

const query = parseSocialWorksQuery(new URLSearchParams("platform=bilibili&year=2025&order=views"));
const initial = await socialTimelineRepository.listWorks({ ...query, limit: 20 });
```

首屏与后续页传相同的 `platform`、`year`、`order`，后续页再传 `nextCursor`。切换平台、年份或排序时从首批重来，旧游标返回 400。`total` 是所选年份的完整数量，空结果返回 0、空 `items` 和 `nextCursor: null`。

`yearCounts` 采用 `{ years: [{ year, count }], undatedCount, timeZone }`。它和列表取自同一份合格快照，统计范围由平台决定，包含该平台的所有年份。年份按倒序返回，只有至少一件作品的年份才出现在 `years` 中。当前年份、排序和游标都不改变这些条数。省略平台时给两平台合计。

每页重新读当前受限快照；撤回与资格变化不保存为旧缓存。游标绑定原快照身份、平台、年份、排序及作品页排序键，指定年份时还绑定站点时区。按时间翻页继续容忍纯统计刷新；按播放/点赞翻页在相应精确数字变化后保守地返回400，避免在新顺序中按旧偏移跳页或重复。不要把统计变更排除在热度游标身份之外。标题/成员/资格等已有失效规则保留。

## 本机演示

显式设置 `CONTENT_PROVIDER=mock`、`SOCIAL_PROVIDER=mock`，运行 `npm run dev`，直接打开 `/works` 或v2 API。全新的演示集包含56件虚构作品、每平台28件，可练习多页、不同年份、合集、跨平台、并列、零与未知数；封面只用本地mock SVG。调用同一SSR入口和API得到相同排序/总数。

mock仅使作品v2与作品页可用，不开启首页社交混排、v1或真实社交媒体接口。`SOCIAL_PROVIDER=disabled`仍默认关闭；database依然严格读真实provider，缺凭据或读失败不会调用mock。此功能不写云端变量、数据库政策或采集调度。

## 分工与验收

后端负责契约、统一服务、HTTP、显式演示适配、排序游标和上述辅助函数；作品页仅调整显式mock的启用门控。UI/UX负责读取页面searchParams并传查询、平台/排序切换、卡片比例/列数、日期文案、年份分组、自动加载及返回恢复。UI/UX的默认B站请求必须显式传platform，URL可省略默认值。接口交付不等于页面已完成或正式上线。
