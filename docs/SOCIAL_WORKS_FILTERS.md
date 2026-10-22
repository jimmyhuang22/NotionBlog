# 作品页平台筛选与排序（F27）

`/api/social/works/v2` 与服务端 `socialTimelineRepository.listWorks` 共用 `SocialWorksQuery`。默认一页12条、最大20条，响应仍为 `{data:{items,total,hasMore,nextCursor}}`，作品DTO没有新增字段。页面的默认B站选择由前端显式传入，接口省略platform仍返回全部作品。

## 参数

| 查询 | 行为 |
| --- | --- |
| 不传platform/order | 全部作品，按作品页发布日期降序 |
| `platform=bilibili` | B站作品，按日期 |
| `platform=xiaohongshu` | 小红书作品，按日期 |
| `platform=bilibili&order=views` | B站按精确播放量降序 |
| `platform=xiaohongshu&order=likes` | 小红书按精确点赞量降序 |

不带platform的order、小红书views、B站likes、`order=time`、未知值、重复参数、未知参数、不合法limit/cursor均为400 `INVALID_QUERY`。按时间时省略order。禁用仍404；真实reader失败仍503，不回退演示数据。响应保持 `private, no-store` 与 `noindex, nofollow`。

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

const query = parseSocialWorksQuery(new URLSearchParams("platform=bilibili&order=views"));
const initial = await socialTimelineRepository.listWorks({ ...query, limit: 20 });
```

首屏统一入口支持相同platform/order，后续页向v2 HTTP接口传相同参数与nextCursor。切换平台或排序后旧游标400，从首批重来。total是筛选后的完整数量，空集合正常返回0、空items、无nextCursor。

每页重新读当前受限快照；撤回与资格变化不保存为旧缓存。游标绑定原快照身份、平台、排序及作品页排序键。按时间翻页继续容忍纯统计刷新；按播放/点赞翻页在相应精确数字变化后保守地返回400，避免在新顺序中按旧偏移跳页或重复。不要把统计变更排除在热度游标身份之外。标题/成员/资格等已有失效规则保留。

## 本机演示

显式设置 `CONTENT_PROVIDER=mock`、`SOCIAL_PROVIDER=mock`，运行 `npm run dev`，直接打开 `/works` 或v2 API。全新的演示集包含56件虚构作品、每平台28件，可练习多页、不同年份、合集、跨平台、并列、零与未知数；封面只用本地mock SVG。调用同一SSR入口和API得到相同排序/总数。

mock仅使作品v2与作品页可用，不开启首页社交混排、v1或真实社交媒体接口。`SOCIAL_PROVIDER=disabled`仍默认关闭；database依然严格读真实provider，缺凭据或读失败不会调用mock。此功能不写云端变量、数据库政策或采集调度。

## 分工与验收

后端负责契约、统一服务、HTTP、显式演示适配、排序游标和上述辅助函数；作品页仅调整显式mock的启用门控。UI/UX负责读取页面searchParams并传查询、平台/排序切换、卡片比例/列数、日期文案、年份分组、自动加载及返回恢复。UI/UX的默认B站请求必须显式传platform，URL可省略默认值。接口交付不等于页面已完成或正式上线。
