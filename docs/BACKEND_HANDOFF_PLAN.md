# 后端交接核对与后续方案

核对日期：2026-11-02，Codex。源码起点为 develop `3d32587`；AWS 发布 #243 已普通合并，main 为 `b9f39fb`，两者文件树一致。本文件区分本次实际核验与待用户确认的设计，不授权安装、改配置或再次发布。执行记录见[本项进度](progress/2026-11-02-backend-handoff.md)。

## 1. B03／R01：AWS 已使用 enforce，公网切换单列

- 自托管配置的默认值为 `DATABASE_READER_ISOLATION=enforce`，两个配置白名单都不接受该键；配置加载会覆盖继承的同名环境变量。AWS 服务没有额外 systemd drop-in 或同名 unit 设置。
- 已核对正在运行的父子进程、专用 preload、实际保护文件、公开构建标记和五份启动模块摘要，均对应受检代码。保护文件早于本次服务启动。Linux `/proc/<pid>/environ` 只提供 exec 时的初始环境，不能据其缺少该键认定运行模式是 off；本次结论来自启动链与当前文件的交叉核对，没有向进程注入调试器。
- 以 AWS 正在使用的配置执行一次严格 reader 守卫和只读元数据查询；网站、社交均为受限 LOGIN，TLS 验证通过。两条连接、四条 SELECT、四条事务控制语句，全部关闭；没有读取私有证据正文、写入或重启。源站健康 204、单条动态接口 200 且返回 JSON `data`。
- 同步公开读取和独立证据读取的安装验收仍引用[10-27 回执](progress/2026-10-27-reader-isolation-cutover.md)，本次没有重复这两类正文验收。私有证据材料绑定历史回执、当前配置／模块及源站检查；`--phase verified --mode enforce --evidence-sha256 …` 声明检查通过。声明检查只校验组合，不替代证据本身。
- 正式域名首次抽查仍跳转 Notion；其返回的 HTML／CSP 不代表 AWS。B03 的公网采用验收须在原部署工作完成切换后再补。旧 Vercel 生产地址实际返回 `402 DEPLOYMENT_DISABLED`，当前停用，旧部署只保留作恢复材料；恢复它须重新核对阶段、配置和发布授权。

## 2. 冻结：沿用已完成演练，增加 AWS 适配

交接提到的原子安装、A／B／C 分段、按对象版本核验一次以及 12 项媒体政策，已由原工作线完成后续修订。10-31 的 G1/G2 结果不能退回为“未开始”：已有四锁内单次有界导出、C1 关闭连接并释放锁后暂停、C2 新进程接续及失败联合回退；已有本机 PG17／假 Storage 的四条获准路径验收。本次只阅读既有材料，没有重跑或修改候选。

12 项媒体也已有决定与候选：三个特定 SHA 的 JPEG 警告例外、八张大海报的有界缩小解码、GIF 保留动画。其原件白名单、输出摘要、字节等价验证和资源限制继续沿用已审版本；不重新询问用户是否保留动画，不将这些例外扩大到其他图片。

AWS 迁移后，原执行稿的 C2 尚不能执行：

1. 当前自托管 `publicAllowed` 不接受 `MEDIA_DELIVERY_MODE`；向文件直接加键会启动失败，不能照搬 Vercel 环境变量步骤。
2. 须先另交付 AWS 的模式白名单、兼容条件与拒绝测试，核对 `MEDIA_PROVIDER`、存储 provider、读权限及真实输出，不把两种 display-only（云端展示图与本机文件目录）混为一种。
3. C2 的有效配置证明改为实际受保护文件、服务启动链、源码提交／BUILD_ID、域名和源站／公开媒体响应；不能再要求 Vercel deployment ID。由构建来源、构建标记和服务实际路径共同证明采用版本。
4. 切换和回退需原子换配置／版本、重建实例、核对页面与媒体；失败恢复旧配置、旧来源版本和旧入口。A/B 保留，门禁保持关闭，沿用同一 C 累计账本和 **90 分钟绝对截止**，不因暂停或重启清零。
5. 保留 A→B→C1→另批网站切换→C2 顺序。11-23 之前只准备；新周期执行前刷新基线、真实目录和日常出口余量。旧提案总保守出口 1.3 GB，不是新周期可用额度或执行许可。

这些是待审的适配要求。本轮没有改现役运行根、候选 pin、凭据、Dagu 或真实锁；原已验证 G1/G2 不需要因此重做整套编码和 SQL 矩阵。后续只补 AWS 接线及受影响的成功／回退路径。

## 3. CSP 与代码／公式渲染限流：待确认方案

### CSP

现有公开构建只发送 `frame-ancestors 'self'`。建议先用 Report-Only 验证来源，再考虑强制：

| 资源 | 第一阶段提案 |
| --- | --- |
| 脚本 | 本站；过渡期保留 inline，生产不允许 eval |
| 样式 | 本站及 inline；Shiki、KaTeX 和现有组件使用内联样式 |
| 图片 | 本站、data、blob；如果浏览器确有跨域最终地址，只加入已验证的精确来源 |
| 字体／连接 | 本站；新增外部依赖逐项确认 |
| frame | 默认 none；先盘点真实嵌入的最终来源，再按需加入 |
| object／base／form／嵌入本站 | object none、base self、form self、frame-ancestors self |

先只在本机演示浏览器控制台收集违规，不新增线上上报入口、外传访客 URL 或持久存储。网站与 Nginx 只选一处生成完整 CSP，避免两份策略取交集造成意外拦截；沿用现有实际强制的 frame-ancestors。

强制脚本策略建议评估每请求 nonce，并在所有 HTML 正常、错误和重写路径保持一致；根布局手写的启动脚本也要带 nonce，覆盖访客伪造的 nonce 请求头。静态启动脚本可用 hash，但它覆盖不了每次变化的 Next Flight 内联载荷，不能只给启动脚本加 hash 就声称已完成严格 CSP。nonce 会影响页面动态渲染和 HTML 缓存，需要在实施前确认该取舍；保留可复用的数据缓存、标签清理、五分钟浏览器返回及撤回边界。

依据已安装 Next 文档 `node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md`。实施时覆盖主页、动态展开、学习层级、作品、相册、搜索、公式、代码、图片预览及 404／503；先本机生产构建，再按发布规则上线，小量抽查。用户和 Claude 审阅方案后才改全局入口／响应头。

### 渲染入口

当前入口是 [`renderSnippets`](../src/lib/render/actions.ts) Server Action，代码与公式共用；调用方为 `browser-document.tsx` 和 `typeset-inline.tsx`。不存在独立的高亮 HTTP 路由。已有输入上限为每次 24 项、合计 60,000 字符；代码另有单项 40,000 字符、单行 1,000 字符和 tokenize 时限。这些只限制单次工作量。

若需要交接指定的 `RATE_LIMITED` 与 `Retry-After`，建议增加同源 POST 渲染路由，复用解析／渲染核心，返回现有 HTTP 错误包装和 503 映射；由 Claude 调整两个浏览器调用方，继续以原文降级。旧 Server Action 若保留也必须经过同一计数入口，不能留下绕过路径。

限额初案：每访客突发 12 次、每 2 秒补一次；实例突发 24 次、每秒补一次、最多并发 2、最多保留 5,000 个访客桶。代码与公式共享额度，独立于搜索额度；准入先于渲染，失败在 finally 释放并发，无来源／数据库读取。计数用进程级共享对象，避免 Next 分包倍增。

AWS 前置 Cloudflare＋Nginx，先核对 Nginx 只信任 Cloudflare 网段并重写访客地址；不能直接信任访客传入的 `X-Forwarded-For` 或 `X-Real-IP`。未确认地址信任链时仅启用实例限制。现有搜索地址提取也列入同一次代理核对，不把其现状当成可信身份认证。此方案涉及共享接口及前端接法，确认后再实现。

## 4. M08：已发现事务池参数不一致

以下为本次 AWS 两条实际连接在同一个 READ ONLY 事务里的元数据，不是负载／取消实验：

| 项 | 网站 | 社交 |
| --- | --- | --- |
| 实际端口／模式 | 6543／configured 实际指向事务池 | 6543／transaction |
| 客户端 statement_timeout | 15 秒 | 10 秒 |
| 服务端 current_setting | **2 分钟** | **2 分钟** |
| 客户端 query_timeout | 20 秒 | 12 秒 |
| 池上限／闲置回收（源码配置） | 2／10 秒 | 1／5 秒 |
| checkout／连接截止（源码配置） | 10 秒 | 10 秒 |

两条连接的 `application_name` 均返回 Supavisor。事实只能说明这次实际服务端值没有采用客户端期望，不能推断所有连接始终如此；也没有用 pg_sleep 验证取消。客户端等待超时和服务端 SQL 停止是两回事，关闭客户连接不在此证明后端语句已经停止。

建议保持网站全局 30 秒请求预算、现有池大小和客户端等待限额。下一份小范围实现应在同一 checkout／同一显式 READ ONLY 事务中使用 `SET LOCAL statement_timeout`（网站至多 15 秒、社交至多 10 秒，并受剩余请求时间约束），将新增控制 SQL 计入预算、错误时回滚或销毁连接；不要先在池上单独 SET 再另借连接查询。需检验事务池上的实际 setting、取消、排空与后续连接不继承设置；不使用角色／全库 ALTER 或加大全局网站超时。

独立运维期限分开处理：

- 原日常 `round-db-export.sh` 使用单次状态读取加 pg_dump；`PGCONNECT_TIMEOUT=20` 只约束连接，脚本当前没有整次导出截止或流式 400 MB 截止。两份既有成功回执的 pg_dump 为约 115／122 秒，压缩归档约 44／51 MB；压缩文件大小不能当作数据库出口。
- 建议导出采用已在 G1 实现并验证的 300 秒／400 MB 计数方式，作为日常导出另行变更的参考。本轮只读现役脚本及回执，没有安装该改动、导出或下载数据库。
- JSON 运维导出／恢复仍复用 [`createDatabasePool`](../src/server/database/connection.ts)，不应通过修改其全局 15／20 秒影响网站。建议专用 owner 运维配置及端到端截止；恢复先提议 30 分钟硬截止，锁等待沿用 5 秒，单语句上限须按相同数据规模的本机恢复计时确定。30 分钟只是待验证提案，没有本次恢复耗时实测，不能标为核验通过。结果不明时停止并分类，不自动重放写入。

资料：[Supabase 连接方式](https://supabase.com/docs/guides/database/connecting-to-postgres)、[超时](https://supabase.com/docs/guides/database/postgres/timeouts)、[node-postgres Client 参数](https://node-postgres.com/apis/client)。M08 仍是“核验部分完成，修复／恢复期限待交付”。

## 5. M04：错误和响应头收敛方案

以现有 [`http-error.ts`](../src/lib/content/http-error.ts) 为公共 DTO 映射基线：INVALID_QUERY→400、NOT_FOUND→404、CONTENT_UNAVAILABLE／RATE_LIMITED／MISCONFIGURED→503，保留通用对外消息及秘密屏蔽。先列每个入口的输入、错误、HTTP 与缓存策略，再提取纯函数；不让 worker 私有错误码成为公开枚举，也不做所有异常一概吞掉。

响应头按用途提供小函数：内容错误 no-store；搜索 private/no-store＋拒绝时 Retry-After；原媒体的浏览器缓存、CDN no-store、no-referrer 和 ETag；健康存活；签名清理控制接口。统一常量不等于把这些差异抹掉。先迁移两个公开 HTTP 包装，再迁移独立媒体／控制接口，每步对照状态、正文和头；不顺便改 DTO、缓存时长、鉴权或 SQL。

## 6. M06：兼容栈用途盘点

| 范围 | 本次查到的用途 | 建议 |
| --- | --- | --- |
| `scripts/ci/check-plan.ts` | 旧自托管树缓存计划；当前两个 workflow 没有调用。实现及测试仍保留，runner 说明明确不复用历史回执 | 可列为后续删除候选；先核对外部调用，另获删除许可 |
| v1 database repository／reader migrations | `DATABASE_CONTENT_VERSION` 的 v1 分支、reader CLI、兼容与协议测试仍引用 | 保留；前端暂未使用不证明运维入口无用 |
| `/media/[assetId]` | 仅 v1 提供，v2 拒绝；旧缓存／旧链接兼容边界尚在 | 列出真实访问需求后再决定下架，不改旧缓存召回承诺 |
| v1／v2／publication 归档工具 | 文档分别规定不同格式和空库恢复，不能互相代替；publication 归档也明确不包括 v1 数据 | 保留；未来删除须同时处理恢复材料与运维手册 |
| `vercel.json`／平台环境／OIDC 路由回读 | 旧托管构建、Preview 隔离和恢复路径仍存在 | AWS 迁出不自动移除，删除／解绑另批 |
| `@vercel/functions` | reader 池的平台生命周期分支；签名清理仍用 `dangerouslyDeleteByTag`，AWS 也保留该调用 | **当前不能整包移除**；AWS 自有池登记仅替换平台 attach 分支 |
| `@vercel/oidc` | 仅平台分支的内部路由认证；AWS 用固定内部 Origin | 保留分支，待平台退役决定后再清理 |
| `src/middleware.ts` 与 Vercel regions | 文件注释保留为旧平台兼容；AWS 同样需要其中的页面状态判定 | 改名／删平台配置分别审查，不连同业务守卫删除 |

盘点是源码及现有文档证据，没有扫描私人运行目录的全部调用者；本轮不删文件、依赖、CI 或平台连接。

## 7. M05：正文完整性与 SQL 结构化设计

正文应分清“采集完整”和“列表已经表达全部”。`document.completeness` 由采集过程的分页、未知块、遗漏子级和上限决定；不能用正文／摘要字符串相等把 partial 升为 complete。列表 `hasMoreBody` 则是展示提示，当前 [`statusPreview`](../src/lib/content/status.ts) 用段落文本比较，不能拿它证明采集完整。

建议用经过现有授权／撤回／媒体投影后的 AST，按明确的块与文本 run 规则比较列表可表达内容；代码、公式、表格、标题、图注、容器、超过九图以及任何 partial／缺失正文均保留更多内容标记。空段、换行、Unicode 组合与非 BMP 字符、相同文本不同结构、撤回链接、被删图片须有代表性用例。不做 NFKC／空白大折叠后猜等价，不改已存正文、未知日期或冻结 DTO。此方案先评审，再在冻结安装后的独立分支实现。

SQL 方面，当前 [`publicationReader`](../src/server/database/publication.ts)、[`scopedReader`](../src/server/database/scoped-reads.ts) 和 [`website-media.ts`](../src/server/database/website-media.ts) 对受控模板做字符串替换。建议新增内部封闭的 ReadOperation 联合类型（version／content／snapshot／selected／search／media），附 mode、projection 和已验证参数，由固定映射生成函数标识与参数占位符；值始终参数化，未知操作明确拒绝。兼容 SqlExecutor 的旧模板适配器只接受精确已知模板，拒绝未知或零／多处不期望匹配。

先比较新旧输出 SQL、参数、资格／撤回、搜索游标、媒体及预算行为，再逐个入口替换；冻结 SQL 文件、协议摘要和安装器产物不重写，不改历史 replace 后重新声明原 pin。涉及同步／运行包的部分留在冻结安装后，不与当前内容同步线并行更改。
