# 影视公共评分与来源

影视公共评分与个人评分分别保存。详情页面使用实际来源标签；来源未知时只显示“公共评分”，不能从旧字段名猜成豆瓣。

## 契约与兼容

Movie 新增两个可选字段：

| 字段 | 含义 |
| --- | --- |
| `publicRating?: number \| null` | 十分制公共评分，0为真实零分，null为明确未知；旧快照可缺失 |
| `ratingSource?: "douban" \| "bangumi" \| "1905" \| null` | 已知评分来源；缺失或null均不证明豆瓣 |
| `doubanRating: number \| null` | 原兼容字段保持原映射和值，其字段名不作为来源证据 |

新字段缺失时，页面可使用原兼容数值并显示通用标签；新字段明确为null时不恢复旧数值。公共评分为空时省略该事实，不显示零分。个人 `rating`、观看日期、影片身份及公开资格保持。

## 来源映射

在影视来源的 `fields` 中可显式配置：

```json
{
  "doubanRating": "Public Rating",
  "publicRating": "Public Rating",
  "ratingSource": "Rating Source"
}
```

原配置无需增加键也可读取：新 `publicRating` 回用已配置的 `doubanRating` 数值，来源保持未知。显式配置 `publicRating` 后优先读取该属性，空值不会回退另一个属性；原 `doubanRating` 映射独立保留。

来源数值超出十分制上限时，仅将该记录的 `publicRating` 和 `ratingSource` 置为null，记录固定警告码 `NOTION_MOVIE_PUBLIC_RATING_INVALID`，不输出页ID、标题、属性名或原值，不阻断其他记录的读取与采集。负值、非有限值及非数值继续沿用基础属性读取的空值规则；真实0和10保留。这里的来源字段归一化不放宽快照校验：外部暂存payload中的越界公共评分仍被拒绝，上游请求错误也仍会失败。

来源标签仅将豆瓣／Douban、Bangumi、1905／1905电影网规范为对应枚举，不从备注、链接、标题或数值推断。未识别的标签不公开原文，来源输出null；评分未知时来源同样为null。不额外读取私人研究备注或提供未经审查的评分外链。

## 发布与运行接续

可选字段通过既有 JSON 快照暂存、发布和受限读取，不新增SQL迁移或修改冻结协议。新校验器允许这两个精确字段，并验证数值范围和来源枚举；其他未知字段仍拒绝。

旧冻结采集／写入程序不因此获得接受新字段的能力。启用真实映射前须由原运行负责人审查同版 mapper、写入校验器、捕获缓存及冻结兼容性；现有转换仍拒绝未批准的新 mapper。不能只更新真实配置后让旧运行包执行。

部署详情标签可以先让旧快照采用通用评分标签；实际来源只有在显式映射、同版采集及成功内容发布后才会出现。工程检查不代表运行包已安装、真实来源已接线或网站已上线。

本项只改变影视公共评分的信息传递及既有详情行标签，不调整页面排版、个人评分、书籍字段或栏目开关。

## 映射策略源码候选

用户已批准独立的影视映射策略候选，见[本次决定](decisions/2026-10-23-movie-rating-policy-transition.md)。`scripts/website-sync/movie-rating-policy.ts`提供工程入口，普通worker、CLI和网站均不导入或自动调用。

`movieRatingMappingAddition`验证两份原始配置和指定source key：只能给一个既有启用影视来源新增此前缺失的`publicRating`／`ratingSource`，前者必须映射原`doubanRating`同一属性，后者必须是另一属性。删除两键后，包含禁用来源和未解析扩展值在内的原始配置语义完全相同；来源身份、顺序、公开范围、时区和个人评分均不能改变。结果绑定原始SHA及解析后的摘要，仅当前进程签发的对象可供后续入口使用，复制JSON不能取得授权。

`applyMovieRatingMappingPolicy`与`rollbackMovieRatingMappingPolicy`要求owner提供独占连接上的事务回调，核对state预期revision／epoch／currentRun、旧摘要、空lease及期限、freshness、完整sources和permits。只更新配置摘要并将revision加一，保留epoch、当前成功指针、历史run、deny与来源范围。回退只接受同一核验对象的精确逆向变化，再推进一次revision，不恢复旧lease或递减历史。

本候选仅用于qualified读取接续，且持久发布扩展必须尚无已采纳指针（或未安装）。已有持久发布指针时，前进和回退都拒绝：该扩展另外要求run与state的配置摘要相同，保留epoch不能保证其旧内容可读。入口在同一事务锁定并检查可选指针，不清除它、不改旧run摘要、不把published reader切换成qualified。此类环境须另行审阅兼容方案，不能直接安装本候选。

逆向操作只回退这一配置摘要变化，不回退程序或网站版本。若新DTO已发布，不能据此安装不认识新字段的旧程序；完整运行包回退仍须单独核对同版读取、写入及当前成功快照。

事务所有语句必须使用[同一数据库连接](https://node-postgres.com/features/transactions)，调用者负责提交、异常回滚及运行窗口。入口还将锁定state时的[事务ID](https://www.postgresql.org/docs/current/functions-info.html#FUNCTIONS-PG-SNAPSHOT)绑定到最终更新，误用自动提交适配器时不执行更新。驱动异常不转发私有值；提交结果不明确时须由owner核实状态，不能自动重试。writer／reader没有此owner操作所需的直接表权限，没有新增角色、SQL函数或迁移。

后续实际运行选择普通完整新采集，不传旧捕获恢复参数，不扩展旧兼容表或恢复目录。旧包与新包的影视、游戏及外部视频投影均有差异，来源证明相同不等于旧DTO适用；新采集须重新固定程序与来源、预算、停止条件、当前策略前像及回退绑定。既有媒体缓存仍须通过原有当前资格和字节核验。本候选的本机临时数据库验证不代表真实运行包、策略或配置已安装；真实操作、合并和部署均未获本项授权。
