# 内容等待分段计时

服务端沿用 `CONTENT_READ_TIMING=enabled` 显式开关；未开启时不建立诊断作用域。计时本身不改变读取结果，后述当前页封面优化与诊断开关独立。输出继续为 `CONTENT_READ_TIMING` 加固定字段JSON，只含操作、类型类别、结果、时长、合法地区以及数字型连接池／阶段计数。没有查询词、路径、页面ID、来源、正文、SQL、参数、凭据或原始错误。

## 操作与阶段

| operation | 作用域与阶段 |
| --- | --- |
| detail／metadata／catalogue | 原有详情、资格元数据及学习目录 |
| search | service、search-read、search-text、search-match、search-version |
| home-feed | home-content、home-social、home-compose、home-hydrate；当前页封面在父作用域记录social-covers |
| social-snapshot | database-pool、social-reader-check、social-collection-check、social-snapshot；v1仍在此作用域补封面 |
| works | 完整作品读取及social-pagination、当前页social-covers；实际社交快照另有social-snapshot子作用域 |

通用数据库阶段继续记录 database-runtime、database-acquire、database-roundtrip、dto-projection。搜索的search-read包含取得紧凑文字投影，search-text包含净化和资格引用过滤，search-match是应用内匹配，search-version保留末尾当前版本复核。legacy搜索仍有整个search及通用数据库阶段，新增text/read精细分段主要覆盖线上使用的scoped路径。

首页两路数据仍并行：home-content为内容索引，home-social为社交快照，home-compose为混排和选页，home-hydrate为获选动态正文及既有版本检查。后续封面优化把v2封面补齐移到选页之后，与获选正文并行；角色／扩展检查和完整资格快照保持，选中的作品才进入同一invoker／RLS封面查询。作品仍按原条件过滤、排序及分页，再补当前页封面。诊断本身没有改变游标或返回DTO，具体优化见[当前页封面读取决定](decisions/2026-10-19-selected-social-covers.md)。

## 解释限制

阶段可能嵌套或并行，**不能把各阶段相加当成请求总时间**。例如home-social涵盖子快照，子social-snapshot里的SQL另有计时；连接获取与SQL往返也不是服务器纯SQL执行或纯排队时间。各操作的AsyncLocalStorage隔离，父首页不会重复累计子社交的数据库阶段。当前v2在父home-feed／works作用域补选中项封面，因此social-covers及其SQL记在父作用域；原始289f822诊断候选则在子快照作用域补全部封面，解释对照时须区分版本。

混合类型操作用kind=unknown，不把用户输入当标签。出错仅记outcome=error，抛出的原provider错误不被日志替换。查询词、内容和错误细节均不进入这些记录；日志失败不影响读取结果。

此计时从服务端函数／读取入口开始，不能覆盖此前的函数排队、模块导入和平台初始化，也不能直接解释已流出外壳后的浏览器动画或完整HTML耗时。原PR488的内部HTTP client不在本轮现网路径中，该传输的headers/body／派发细分仍需在独立候选继续验证。没有新增Server-Timing响应头，完整流式结束后才知道的阶段不能冒充早已发送的头。

## 验证与使用

本机使用合成fixture和隔离SQL校验新增分段、原结果、SQL次数、版本变化拒绝、两源并行及错误传播。下一次获准的云端候选应沿用当前生产配置，先核对版本及正式域名未切，再对搜索、首页、作品各取少量有界样本，并用平台request ID对齐日志；不需要重采来源或图片来刷新计时。

本机通过不等于线上性能已提升。后续封面优化收缩只读SQL的选取范围，不改schema、角色、公开资格、撤回或跨请求缓存，不安装或改变同步运行包。未来读取改动继续基于分段验证，并保留最终版本的发布要求。

已按随后授权完成一次Production配置候选，固定源码289f822；普通搜索／首页／作品函数实际sin1，7个主动候选请求的分段均已匹配。搜索主要为文字投影读取往返，首页／作品主要等待包含封面资料查询；不是媒体下载时长。原样本及限制见[云端验收记录](progress/2026-10-19-content-wait-timing.md)。候选只增加诊断，未证明提速，正式域名保持F35；该次授权已使用，不自动增加部署或晋升。


当前页封面版本随后另获一次候选授权，固定d7f6fd0并完成14个有界HTML GET。7个候选请求分段匹配：作品封面98–100ms、首页封面79–92ms；作品完整响应三点中位1.048→0.444秒，首页中位1.298→1.314秒，首次候选仍2.016秒。搜索读取仍3.245秒。可见文本与链接／图片引用相同，但未做浏览器交互、严格冷启动或p95验收，正常DNS的两个部署入口IP也不同。正式域名仍为F35，PR未合并；具体样本、剩余首页内容索引与作用域外等待及发布建议见同一[验收记录](progress/2026-10-19-content-wait-timing.md)。该次新授权也已使用完，不自动继续部署或重放。


后续兼容性续接已将develop47f765c（含498稳定封面引用及F36）合入497工作分支，应用fefd850通过组合回归与构建；完整测试首轮的两处本机环境失败及原文件9项复验结果分别记录，不改写历史。组合仅本机验证，未新增部署／页面测量；正式站已由其他发布流程更新为F36。上述d7f6fd0云端计时仍按旧固定版本解释，详细集成结果见同一进度记录。


最新续接已修复与合集按日累计接线的runtime冲突，保留trial／retained的原开关与站点时区，同时兼容稳定图片的ETag／304条件缓存。新集成应用f8f8558一次完整check（2,300测试、类型／三协议／隐私）与build44trace通过；16项组合回归通过。后续仅同步发布验收记录，没有新的云端性能样本。具体受检版本与发布状态继续以同一进度记录为准。


发布518已合入main b66924a：精确来源平台run647完整check/build通过（2,300项零失败／跳过），内容树核对一致；唯一Git Production部署READY，正式域名与该提交对应。此为平台与部署验证，本轮未增加页面／媒体请求；新正式版前后耗时仍待同14页验收，不能直接沿用旧d7f6fd0候选数字。发布实际状态与后续页面验收边界见同一进度记录。
