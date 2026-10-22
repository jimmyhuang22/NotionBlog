# 同批次代表访客验收

入口 `scripts/visitor-acceptance/cli.ts` 是独立操作工具，默认不启动服务器。`plan` 只读私有输入与已有构建；`run` 在受检项目内启动单个隔离的生产 Next 进程，绑定 loopback，读取受限数据库和 COS。不会改正常网站入口、部署、资格、调度、writer 锁或公开范围。

## 输入与操作顺序

使用同次 accepted-full、真实来源配置、**已登记且经过独立验收的同次小图选择**，不能用整个历史候选库替代。默认 `mediaPolicy=required400`：必须有一张被当前正文／封面引用且已登记的400小图，优先选这种原件并在请求中核对小图SHA；没有则离线计划即拒绝。需要单独检查纯内容／原件时可以显式 `--media-policy original-only`，该模式允许空选择和原图fallback，结果明确 `thumbnail400Verified=false`，不能用于首次小图切换验收。如果数据库实际存在不相符小图，SHA 检查失败。

计划选择一条动态、一门有笔记的课程及其优先子笔记，检查列表数量／年份、详情、课程树、动态／笔记 HTML、关于页（存在时）、未知笔记／媒体 404，以及所选原件和它的400／800请求。没有课程或动态代表则拒绝；original-only模式没有被引用图片时明确报告，无图片验收证明。

准备独立 reader profile：database／v2／published、storage／cos、thumbnails enabled、DATABASE_TLS verify。只允许 CLI 所列键；Notion、writer、Auth／Storage写入、NODE_OPTIONS、NEXT_PUBLIC 等不进入子进程。引用的私有site文件只读取一次，以已审JSON在子进程内存消费，不随其他操作中途改文件而漂移，不落合并env文件。COS凭据必须是既有受限独立reader，工具限制已选对象GET，不证明云IAM本身；实际权限须由运行拥有方另外核实。数据库在真实连接检查目标、verifyTLS，并核验实际 LOGIN／nb_reader 全成员图与最小能力，强制只读启动参数；不重写端口、不放宽证书验证。

```sh
node scripts/visitor-acceptance/cli.ts plan \
  --config /private/source.json --artifact /private/same-full.json \
  --thumbnails /private/registered-selection.json --env /private/visitor-reader.env \
  --duration-ms 300000 --http-requests 64 --response-bytes 67108864 \
  --sql-queries 256 --sql-row-bytes 8388608
```

`run` 再提供 `--operation` 全新 owner-only 目录、`--phase pre|post`、实际审阅 `--plan-sha256`、绝对 Unix 毫秒 `--deadline-ms`、本地 `--port`。同一 operation 的 pre/post 使用完全相同的工件、环境、站点配置、配额、Node位置／版本与受检构建摘要。pre 创建操作；post 必须读到同一操作最终 passed 且完整收尾的 pre 回执。两个固定 slot 都用排他创建，取消、失去回应或崩溃后不能重启免费追加额度。新操作仍需运行拥有方另行审阅与授权，不自动创建替代操作。

正常构建须先在隔离工程完成；工具冻结 `.next` 中服务器／静态文件及构建清单、两个锁、入口所用源码和Next配置，运行后再次检查。Next可能生成组可写文件，运行拥有方须在**自己的隔离候选**中移除构建文件的group／other写权限后再计划，不修改共享运行release。构建缓存、trace、dev／types 不充当应用代码。候选中存在 `.env` 等真实默认文件或 `config/site.json` 时拒绝，防止 Next 隐式加载未审输入。Node24和同锁依赖沿用现有候选，不安装新包；其二进制及依赖的完整性继续使用原运行候选manifest证明，本工具另绑定Node位置／版本。保持项目与构建在操作期间不可修改；摘要检查不是对恶意并发写入的文件系统隔离。

## 停止预算与证据

每半段最多5分钟／64次累计HTTP／64MiB已接收回应／256次应用SQL／8MiB行JSON。请求包含 loopback 访客与后端 COS GET **两条链路**；同一媒体回应可能在两处接收，分别计数。仅 `pg.Client.query` 物理入口计SQL，Pool转交不会重复计；失败请求不退款。还有每段3次PG连接尝试、64MiBSQL请求JSON防御上限。共享私有账本在每次调用前保留额度，回应或迟到行／块先累计再判断取消；超限、重定向、Source／Auth／外部图／上传／非既定读SQL立即停止，无自动重试。

两段固定 slot 使合计最多128HTTP／128MiB回应／512SQL／16MiB行JSON；每半段的期限取5分钟与明确绝对截止较早者，包含启动和收尾，不额外增加维护窗口。pre需占用原独立验收阶段预留5分钟，post在既有切换阶段预留5分钟内。应用字节不包含TLS／PG帧、DNS、错误包、连接握手或云计费，不能当完整账单。

子进程在导入 Next／路由前安装 fetch与物理pg护栏；原生HTTP外呼拒绝。在**隔离服务器**中拦截Pool原型（包括Next已缓存的构造器导出），相同reader配置共用一个max1池，TLS／连接与查询超时保持；不修改正常网站的连接池。每个SQL投影的批次／政策／schema与计划一致，监督进程前后再读取现有受限状态。服务器仅接受持有随机nonce的既定GET路径，不做任意浏览器加载。

流式HTML与SQL回应可同时到达，账本短锁仅允许在同一硬期限内等待至多250ms；不抢锁、不续期、不退款、不重试任何网络请求。原子替换可在open/fstat间取消旧inode的链接；只有前后inode明确改变时才在同一250ms内重读守卫，稳定坏文件仍立即拒绝。锁持续不释放或观察值未能持久保存时，标记计数不完整并停止。停止后排空已启动任务并结束连接／服务器；强制杀进程或未收到完整收尾则 `accountingComplete=false` 且失败，保留可能未知的剩余流量，不用最后可见计数伪称完整。前段最终回执须与其原始ledger摘要和累计值相等，后段冻结该回执SHA并报告combinedCounters，不接受任意“通过”JSON。

私有回执和账本保留诊断；stdout只有摘要、阶段、计数和静态错误码，不输出路径、正文、来源标识或凭据。底层Next日志不转发到终端。failed／started不作为通过，不删除这些证据。

## 覆盖边界

这是**隔离受检站点进程的服务端路径验收**，覆盖生产Next HTML／API→受限数据库→代表对象回应；不证明远端域名、Vercel版本、跨地区网络、社交首页、浏览器hydration、全部排版或全部媒体。远端服务器的实际SQL无法由HTTP客户计数，当前入口不把远端成功请求冒充完整SQL守卫，也不把本地post称线上切换成功。需要发布拥有方把线上HTTP／部署身份与前端实际浏览器检查另行接入同一明确窗口；若要求远端SQL同样硬停，须在另行批准的服务端执行环境接入守卫，当前未实现该云端接线。

全对象SHA验收仍由[独立媒体验收](INDEPENDENT_MEDIA_ACCEPTANCE.md)完成，小图由[SQL登记](PUBLISHED_THUMBNAIL_REGISTRATION.md)先绑定。这里不重采Source、不下载完整图库、不重新生成或上传小图；代表图片失败也不触发整轮同步。
