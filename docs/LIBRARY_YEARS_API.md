# 作品库年份筛选与统计

反馈交接包 06 的 B2 后端接口已就绪。影视、书籍、游戏通过统一内容入口读取，不在浏览器拉取全库。自动加载、年份控件和页面查询参数的接入由 UI/UX 继续完成。

## 调用

```ts
const years = await contentRepository.getLibraryYears("movie", { status: "watched" });
const page = await contentRepository.list("movie", {
  status: "watched", year: 2026, order: "date-desc", limit: 24,
});
```

`kind` 使用单数 `movie`、`book`、`game`，与列表契约一致；页面路径仍是 `/library/movies`、`/library/books`、`/library/games`。

| 浏览器入口 | 返回 |
| --- | --- |
| `GET /api/library/movie/years?status=watched` | 当前可公开且“看过”的影视年份统计 |
| `GET /api/library/book/years?status=read` | 当前可公开且“读过”的书籍年份统计 |
| `GET /api/library/game/years?status=completed` | 当前可公开且通关或白金的游戏年份统计 |
| `GET /api/content/movie?year=2026&status=watched&order=date-desc&limit=24` | 筛选后的列表、总数与游标 |
| `GET /api/content/book?year=undated&status=wishlist` | 未记录阅读日期的想读书籍 |

不传 `status` 时统计该栏目的全部可公开作品。统计只接受可选的 `status`，沿用现有状态集合，游戏 `completed` 包含 `clear` 与 `platinumed`；不接受 `year`、`order`、分页或其他筛选。无效或重复参数返回 400。年份切换仍显示当前状态下的完整年份分布，不随所选年份缩小。

返回使用 `{ data: LibraryYears }`，与 `StatusYears` 同形：

```json
{
  "data": {
    "years": [{ "year": 2026, "count": 12 }, { "year": 2025, "count": 8 }],
    "undatedCount": 2,
    "timeZone": "UTC"
  }
}
```

年份降序且只列有记录的年份。计数针对完整合格集合，先按状态筛选，再按年份聚合，不受分页大小影响。列表的 `total` 则包含所有所选列表条件，先筛选再分页。

## 日期与分页

影视用 `watchedDate.start`，书籍用 `readingDate.start`。游戏使用服务端 `archiveDate`：人工 `playedDate` 有结束日取结束日，否则取开始日，再与 `lastPlayedDate` 比较，取较晚的一天；只知一侧用该侧，两侧未知才归无日期。游戏年份统计、筛选、日期升降序与列表分组均使用这个日，人工体验范围不改写。其他类型的日期范围仍取起始日。

| Game 字段（列表／详情／元数据／快照均提供） | 含义与兼容 |
| --- | --- |
| `playedDate: DateRange \| null` | 原人工体验范围，保留原精度；不是平台日期的写入目标 |
| `lastPlayedDate?: DateRange \| null` | 可靠关联平台的最近游玩；只到日，缺失或未知公开为 null |
| `firstPlayedDate?: DateRange \| null` | 可靠关联平台真实首次的最早日期；只到日，Steam 不存在的数据保持 null |
| `archiveDate?: DateRange \| null` | 当前服务端计算的归档日；日期 `YYYY-MM-DD`、`precision=date`、`end=null`，两侧未知为 null |

平台日期在所有 provider 的公开输出转换到配置的站点 `timeZone`，旧数据库时刻同样截断；已有纯日期不再作 UTC 换日。原始平台时刻不会通过列表、详情、快照、首页等输出。`archiveDate` 在读取时重算，不沿用存储中的旧派生值；客户端用该字段，兼容旧服务时沿共用 helper 回到人工日期。所有新增字段均可在旧存储快照中缺失。

没有浏览日期归入 `undatedCount`，用 `year=undated` 筛选；不从发行、编辑、账户同步、首次游玩或时长推断归档日期。想看、想读、想玩有真实日期仍按该日期归类。最近游玩不证明通关或逐年活动历史，首次也不代表通关日期。

列表 `year` 接受 1–9999 的整数或 `undated`，可以组合已有的 `status`、`order` 及该类型支持的其他条件。切换状态、年份、排序、分页大小或时区须清空游标；内容批次或资格变化导致游标失效时，沿用一次从第一页重载的处理。年份应进入列表组件的 `key`、翻页查询以及返回恢复的缓存标识。

`src/proxy.ts` 的作品库路由资格检查不拒绝查询参数，新增年份不会被拦截。页面读取 `year` 和绘制控件仍需 UI/UX 接入。统计失败可以只隐藏年份控件，列表继续走自己的读取与错误处理。

## Provider 与边界

- mock 使用虚构作品，平台日期示例已改为日并加入虚构首次日期；读取时补齐与真实 provider 相同的归档字段。
- Notion v2 逐项验证当前来源、允许名单、归档／删除状态后统计；只读属性，不读正文、不登记封面。
- database v2 使用既有 `nb_v2_api.read_snapshot`，一次读取当前合格元数据后在服务端筛选和统计。沿用 20,000 条／16 MiB 的有界快照约束和撤回、资格过期检查；访客只收到统计或本页 DTO。没有新增 SQL、迁移或更改冻结同步契约。v1 仍是原 Status／学习兼容模式，不作为作品库后端。
- 所有 HTTP 响应为 `Cache-Control: no-store`。关闭栏目或不支持的种类返回 404；真实 provider 失败／资格过期返回 503，不回退 mock 或旧统计。

本轮验证为演示数据、合成 Notion 客户端及本机 PGlite 的实际受限 SQL；未读取真实作品库或更新云配置，不能作为线上、目标地区网络或 UI 验收。

## 发布接续

读取代码可立即给旧批次算出 `archiveDate` 并截断已有平台时刻；旧批次没有的平台最近／首次字段仍为 null，需要显式来源映射与后续正常内容发布才出现。Notion 汇总映射分别要求 `latest_date`／`earliest_date`，不读取平台明细作为独立网站来源。正式部署与内容发布需协调服务器和页面使用同一日期规则；首次详情行由前端接入。此工程交付不启动额外账户采集、全量同步或媒体上传，不切换运行包和线上模式。
