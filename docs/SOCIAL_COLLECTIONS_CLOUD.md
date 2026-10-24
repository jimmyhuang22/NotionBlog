# 合集云端与时间线 v2

用户同意在本地合集后端之后继续云端模型、成员归属／去重与统一读取。此扩展位于已有 private social_sync 域，复用原 nb_social_worker／nb_social_reader 登录，不轮换凭据、不修改旧协议版本、单发布表或旧 API；迁移只增加合集对象与受限授权。原内容／媒体域、网站公开政策、部署和调度保持。

## 上传与源数据

`social-collections.sqlite` 升级到本地 schema 2，增加独立合集 outbox。写入模式显式事务升级并将旧库的各合集最新采样排队；只读模式仍能读取 schema 1，pending 此时为 null。原 social.sqlite 不迁移。成功的新采样同时保存历史、最新状态与待传快照，重复／旧采样不新增队列；失败保留数据。已排队项按稳定合集键合并，不上传整个本地历史。

```sh
node scripts/social-sync/cli.ts collect-collections /ABSOLUTE/PRIVATE/social-collections
node scripts/social-sync/cli.ts upload-collections /ABSOLUTE/PRIVATE/social-collections
node scripts/social-sync/cli.ts collections-status /ABSOLUTE/PRIVATE/social-collections
```

同目录 collection-config.json 与原格式 cloud.env 为 600，目录 700，使用外置 SSD 的独立目录。发送器校验已登记目标、原有低权限登录／会话、独立 collection_meta 版本 1、严格 TLS、字段／身份／摘要与 512KiB 上限。最多读取一百条／8MiB 队列，当前配置外的目标跳过且保持待传；CLI 整轮两分钟，每个 SQL 十秒／客户端十二秒。错误、取消、提交后丢回执与错误摘要都不确认；重试幂等，旧在途回执不能清除新的排队版本。旧 upload 仍拒绝新结构。

云端仅接收严格合集快照，自己比较历史 BV／完整 CID 并生成卡片和内容活动，不能由发送端直接写更新时间、摘要或成员公开身份。源数据保持会员列表完整性、未知 P 完整性、实际发布时间与采样时间，参见 [本地合集](SOCIAL_COLLECTIONS.md)。SECURITY INVOKER 函数、列级写权限、RLS 和触发器共同限制直接 SQL：worker 不能修改派生卡片、审批、绑定、单独展示例外或删除数据；reader 不能读原快照／历史、写入、调用 ingest 或触及旧内容域。源快照、曾见成员和完整 P 基线合计最大 2MiB，历史容量沿用本地边界。

## 逐成员展示与去重

collection_bindings 默认未启用，collection_visibility 和 collection_member_reviews 默认未批准。采集、绑定或上传不授予网站资格。合集需要自身有效资格，以及全部当前成员的精确版本批准；成员签名覆盖 BV、所列 CID 和 P 完整性。新增成员、P 列表变化或完整性变化没有相应审批时，整张合集暂不返回，不只把未批准成员从计数中删掉。集数、合集统计、更新摘要不泄露未确认范围；删除后重加且签名相同只复用尚有效的审核，不伪造新增事件。

临时资格仍最多二十四小时，源采样须在二十四小时内，撤销／过期／禁用立即影响后续请求。固定标题来自人工合集资格，不自动把源标题编辑公开。未知实际更新时间为 null，addition-detected 是单独标明的检测活动，不能称为发布日期。长期新成员自动展示政策尚未冻结。

新时间线只在合集当前合格且 BV 当前属于它时，折叠相应独立 B 站发布。资格失效或成员被移除，不会以过期合集抑制仍按旧资格合格的独立作品。collection_standalone_overrides 可由操作者显式保留独立卡，worker／reader 无写权限；旧发布接口的条目不被这个新接口的去重改变。

跨平台仍使用人工 workId 关联。合集稳定作品键为 bc_ 加合集键前四十位；经过人工确认并绑定到同一键的其他平台发布，与合集成为一件作品，各自指标保留。不按标题猜测关联、不累加为共同热度、不把原作品 occurredAt 改作检测时间。

## 网站入口与 Claude 交接

- `GET /api/social/works/v2?limit=12&cursor=...`：单作品／笔记与合集的完整社交分页。
- `GET /api/home/feed-v2?limit=16&cursor=...`：内容与上述完整社交快照统一排序／分页。
- [独立 DTO](../contracts/social-timeline.ts)，服务端统一入口 `src/lib/content/social-timeline.ts`／`home-feed-v2.ts`；旧 SocialWork、HomeFeedItem 与现有页面不改。Claude 接入后显式选择 v2，不能把两份分页在浏览器里拼接。

v2 每个 work 增加 collection，单作品为 null；合集时 publications 可为空，或含人工关联的其他平台发布。合集对象保留 memberCount、可为空的 partCount、明确统计口径、原始／成员日期、activity 和 latestAddition。work.occurredAt 仍是原作品日期；首页 item.occurredAt 是用于时间线排列的活动时刻，来自 collection.activity 或原作品日期。检测活动必须在卡片标“发现合集更新”，不标平台发布日期。首次基线 latestAddition=null，统计刷新保留排序时刻。

新 SQL 一次读取当前资格、合集、成员折叠与平台发布；最多五百件作品、每件二十条独立发布，以 501／21 哨兵检测超限，8MiB 社交投影与 24MiB 混排预算，超限整页报错。游标含 v2 范围、源版本、时区、模式与页大小；源或资格变化重置首批。默认沿用 SOCIAL_PROVIDER=disabled，不改开关；显式 database 缺迁移／权限／源失败时 503，不静默退回旧社交或 mock。所有响应 no-store／noindex，无写入 HTTP。

原平台链接需要单独实际核验。数据库及 DTO 只接受匹配作者／合集的标准列表地址，或匹配多 P BV 的标准视频地址；附加参数、身份替换、任意域名和会话参数拒绝。核验时间距资格检查最多五分钟，未验证为 null。格式验证不是实际访问证明；合集统计中的评论数没有一个对应的合集评论区，合集链接应标“打开合集”，再在平台选择单集查看评论。

## 验收边界

本地 Postgres 引擎已验证独立权限、server/local 更新状态一致、全部成员门槛、撤销／过期／新成员、成员删除和独立展示例外、跨平台归组、私有字段排除、旧 API 不变、游标与上传回执。正向病例为虚构测试或明确标记的私有真实样本重放，不冒称实际云端已公开。

用户明确批准的试验云端安装与两合集私有上传已完成：六表／两视图安装、仅两绑定／两状态，正式 worker 回执与本地卡片一致，173 个成员签名保留为私有数据；重试零上传。再采集并更新同两合集时零新增，仍保留两张卡及原活动时间。真实合集／成员审批均零，因此实际 reader 与网站新旧社交 HTTP 都返回空页。正向两卡 DTO／HTTP 仍仅在离线审批重放验证。旧五条发布总摘要、旧协议与原本地数据库均保持。详见[本项进度](progress/2026-10-12-social-collections-cloud.md)。

首页仍使用 v1，Claude 后续接入已有卡片；原平台合集标准链接已实际访问核验，本机 JSON 浏览器打开被 Chrome 拦截，native HTTP 请求验证通过。代码、私有库、凭据和验收均在外置 SSD，没有安装新常驻服务、自动采集或部署。真实展示资格、长期新增成员政策、全量目录／详情、封面与无人值守平台登录仍待完成。

依据：[Supabase invoker 视图](https://supabase.com/docs/guides/database/views)、[RLS](https://supabase.com/docs/guides/database/postgres/row-level-security)。

## 固定配置上传的历史待办筛选

`upload-collections` 先用当前 `collection-config.json` 的获准键筛选待办，再执行原有最多 100 条／累计 8MiB 的负载检查。历史移出配置的项只统计为 skipped、保持 pending，不占名额或负载预算，也不因其数量超过 100 阻止当前目标上传。配置仍最多 20 个合集；真实上传、周期任务和公开资格均不由源码更新自动启用。无筛选的导出保留原上限，超限仍明确失败。
