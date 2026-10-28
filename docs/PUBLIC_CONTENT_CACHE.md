# 公开内容缓存与本机下架

状态：首轮工程已随既有发布进入网站，模式仍关闭。本项尚未安装缓存 SQL、配置生产变量或修改运行调度。前端 #594 常规补修与 #600 晚到首屏修复均已接收，后者在实际合并提交上四个定向浏览器场景通过；安装、实际接线及开启后的有限验收仍待，不能仅合并代码就启用。用户决定见[决策记录](decisions/2026-10-21-public-content-cache.md)。

## 读取与缓存

`PUBLIC_CONTENT_CACHE=tagged-v1` 仅支持 database v2／qualified，包括已有最后成功批次读取；其他模式不能误用。还需要匹配的 `PUBLIC_CACHE_SITE_KEY`、固定 HTTPS `PUBLIC_CACHE_ORIGIN`、64 位十六进制 `CACHE_PURGE_SECRET`，以及扩展的 `enabled=true`。缺少能力或配置时明确失败，不切回演示数据或旧缓存。

媒体共享缓存另按实际读取方式收紧：实时 Notion 核验的原图，以及 `live-notion`（含默认值）的小图成功响应，不升级为共享 CDN 缓存。数据库资格的小图仍可缓存；缺图或临时传输失败回退到实时原图时，保留原图的排除标记。这个标记只存在于服务器的响应对象，不由客户端请求头控制。新缓存模式仍要求浏览器每次复用前重验证，资格通过后可返回 304；关闭新模式时保留原有私有浏览器期限。已存在的 CDN／浏览器副本不会因源码改动自动清除，发布验收须包含旧缓存过渡。

托管环境将 `CACHE_PURGE_SECRET` 保存为 Secret，不使用 `PUBLIC_` 前缀，也不改用可读 Config 存储密钥。服务端资格签名、清理校验和本机操作入口共用同一读取方式。冻结的本机 operator／publisher 环境仍可使用旧名 `PUBLIC_CACHE_PURGE_SECRET`；两名同时设置时必须一致，不同则明确失败。兼容旧名不表示批准在托管环境使用旧名或降低密钥存储类型。

服务端统一入口缓存最终 DTO，包括元数据、栏目、年份、详情、目录、首页和两版社交接口；搜索不缓存。缓存键包括站点／配置／数据连接身份摘要、投影与公开版本、完整方法参数和固定日窗口。每个到达函数的读取先用独立只读能力检查当前版本；冷读取结束再检查一次，撤回中途不写入旧结果。一个日窗口不超过 86400 秒，切换后不会用后台刷新继续返回旧窗口；有效大文档超出 Data Cache 限制时走不存储路径。

当前 Next16.4 的 `force-dynamic` 会阻止显式缓存读取。后端相关 GET 已移除该声明，保留请求参数校验；前端页面需跟进。使用仍被本版本支持的 `unstable_cache`，不在本轮全站强开 Cache Components，避免与其他页面的动态声明同时冲突。根布局不再强制动态，启用时 ISR `expireTime=86400`，客户端 Router Cache 的动态／静态复用均为 5 分钟（2026-10-28 用户选择，见[回访决定](decisions/2026-10-28-public-cache-revisit-five-minutes.md)）。

成功 API 和 v2／社交媒体响应使用浏览器 `private,no-cache,must-revalidate`、ETag，以及可按标签强制清除的 Vercel CDN（至本窗口结束，最多一天）；其他 CDN 为 no-store。原图及 400／800／1600 各自 URL 分开缓存。已有浏览器一天副本无法召回，存在旧政策过渡窗口。跳转、错误、健康检查、搜索及内部预览不放入此共享缓存。当前 404 HTTP 仍 no-store；元数据不存在结果可缓存，但随版本变化和页面标签失效。

中间层仍用 `src/middleware.ts` 的既有部署兼容名称。实际本机原型发现中间层直接使用 Data Cache 没有复用，所以启用时它只访问固定的 `/api/internal/cache/route`。这个普通 Node 接口按相同版本缓存资格，六秒外层／五秒查询边界，区分 found／missing／unknown，未知返回 503。请求用与 purge 不同用途的 HMAC 签名，不信任访客 Host，也不对任意 URL 发请求。本轮没有地区配置变更，不能据本机结果承诺正式执行区域或延迟。

在 Vercel（`VERCEL=1`）中，资格请求的固定目标来自平台 `VERCEL_URL`，请求和 HMAC 同时绑定 `VERCEL_DEPLOYMENT_ID`，响应也必须匹配该标识；缺失配置、旧部署响应或身份不可用都明确失败，不回查旧正式域名。服务端通过直接依赖的 `@vercel/oidc` 同步 getter 获取本次调用的短期身份，只发到该部署的 `x-vercel-trusted-oidc-idp-token`，不刷新 CLI 登录或使用永久绕过密钥。部署标识也隔离 Data Cache 条目。非 Vercel 本机模式继续使用明确配置的 Origin，不请求平台身份。`PUBLIC_CACHE_ORIGIN` 仍是本机清理／下架操作的固定站点入口。

[Vercel Trusted Sources](https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/trusted-sources) 默认支持同项目同环境自调用；保存过的自定义规则会替换默认规则。[系统变量](https://vercel.com/docs/environment-variables/system-environment-variables)须在候选运行时可用。安装验收要用受保护候选确认真实自调用与身份规则，不能把本机签名测试当作平台授权通过；不自动修改访问规则。候选清理入口的外部调用同样要使用已有受保护访问能力，不能把身份缺失的 401／403 当作清理成功。

## 标签与刷新

标签前缀 `nb:public:v1:`，范围为 `content`、`social`、`home`、`media`。首页依赖 content＋social＋home。初版有意按范围清除，含各参数、分页、旧图片版本和负结果，不逐页拼一个可能遗漏的 URL 列表。撤回页面只撤它的授权，广泛清缓存不等于删除其他页的共享文件。

独立扩展在成功切换 v2 当前批次的同一事务中写 content 待办，进程提交后掉电也不会漏记；社交投影和小图映射的已存在表安装观察触发器，每事务每范围记一次。回滚不留下成功事件，安装时默认关闭，冻结的旧 SQL／采集协议不改。后续新建的投影表需审阅是否加观察器。显式成功 ACK 也可用下面的生产者入口补登记。

持久事件与公开内容分别记账。`/api/internal/cache/purge` 只接受短时、本站 HMAC 和数据库实际事件，强制删除 Next 数据／页面及 Vercel CDN 标签；不采用会继续返回旧内容的软失效。网站只有 reader，不能下架或写事件。受限 publisher 只能写／确认缓存待办，不能修改公开范围。重复调用幂等，HTTP 结果未知则保留 pending。

```sh
# 使用独立私有 publisher env；成功回执形状见下文
node --env-file=/absolute/.local/publisher.env scripts/public-cache/refresh-cli.ts /absolute/.local/success.json --execute
node --env-file=/absolute/.local/publisher.env scripts/public-cache/refresh-cli.ts --flush
```

成功回执为 `{ "scope": "content|social|media", "version": "64位摘要", "committed": true }`，必须来自实际成功发布／ACK，不能用采集中的输入代替。持久队列每次最多看 100 条，按最大 generation 合并各范围的 purge，完成后只确认该快照中的更旧事件；并发产生的新事件留给下一轮。中断或失败保留其余待办，不重采或重传。

独立消费者已有单次入口，可手动重复同一命令重试数据库里的遗留待办，不需要再次提供成功回执：

```sh
node --env-file=/absolute/.local/publisher.env scripts/public-cache/consumer-cli.ts --once --state /absolute/.local/cache-consumer/state.json
```

也可用 `npm run content:cache-consume -- --once --state ...`。每站使用一个固定私有状态目录：专用锁不等待、不抢占，不取得来源采集的六把锁；并发调用在打开数据库之前退出。状态绑定站点、Origin 和连接摘要，改变身份须使用经过审阅的新目录；不能改旧文件强行续用。状态文件及各次 `attempt-<id>.json` 为 0600，记录启动、阶段、完成数、最终待办窗口、固定错误码及最后一次成功，不记录凭据、正文或驱动异常。队列读取失败时待办数为未知，不报零。中断遗留锁要先确认原进程已终止再按现有锁恢复流程处理，不自动偷锁。

退出码 0 表示本次观察到队列空；1 表示失败；2 表示还有待办或需 operator 恢复下架。`remainingAtEnd` 是最多 100 条的最终窗口，`windowMayBeFull=true` 时不能当作全队列总数。`withdraw` 不由普通 publisher 清理或确认，必须接续原下架计划的 `--resume`，避免绕过其页面／图片验证。清理已成功但 SQL 回执丢失时，下一次先读真实队列，绝不依照本机计数重做内容发布。

消费者 30 秒后停止发起新操作，HTTP 同时沿用单次 20 秒限制；已开始的 SQL 沿用连接层的 15 秒 statement／20 秒 query 限制并收尾，不用 `Promise.race` 丢下后台写入。因此不是严格的 30 秒整进程终止承诺。成功生产者应单独唤起该入口；监控必须检查退出码与私有状态中的 `failed`／`pending`／`operator-required`，不能只看来源同步成功。当前仅有命令和回执能力，没有安装自动监控或消息通知。

运行接线由同步拥有方在启用前完成：成功发布／社交 ACK／图片登记后唤醒独立缓存消费者，并由后续消费者检查遗留 pending；不要把消费者错误接进会暂停整个采集的旧关键路径。它只重试刷新事件，不重新发布内容，也不修改现有采集计划。本轮没有把消费者安装到运行环境或创建计时器。

## 立即下架

先安装扩展和受限 operator；凭据只存在本机私有 env。`PUBLIC_CACHE_OPERATOR_DATABASE_URL` 必须实际登录为不继承、不提权的 `nb_cache_operator`，publisher 同一字段使用 `nb_cache_publisher`；TLS 沿用严格证书校验。根网页环境不得配置这些账号。

```sh
node --env-file=/absolute/.local/operator.env scripts/public-cache/withdraw-cli.ts https://example.invalid/study/course --plan /absolute/.local/withdraw/plan.json
node --env-file=/absolute/.local/operator.env scripts/public-cache/withdraw-cli.ts --execute /absolute/.local/withdraw/plan.json
node --env-file=/absolute/.local/operator.env scripts/public-cache/withdraw-cli.ts --resume /absolute/.local/withdraw/plan.json
```

也可从私有 env 载入后使用 `npm run content:withdraw -- ...`。接受本站页面 URL、动态锚点／focus URL，或 Notion 页面链接；只解析身份，不访问 Notion。计划文件是 0600、本机忽略目录，绑定站点、连接摘要、当前批次／版本、子树和全部历史媒体关系。

历史媒体查询的可选 owner 索引、共享旧地址检查和四万个不同资源的容量边界见[撤回索引说明](PUBLIC_CACHE_WITHDRAWAL_INDEX.md)。不要把历史范围直接缩为当前批次；超过计划上限时本次撤回尚未执行，不能当作已完成。

默认 v1 保持上述边界。用户批准的[紧凑计划 v2](COMPACT_WITHDRAWAL.md)提供显式 `--compact` 新路径，以完整历史摘要和数据库共享检查支持最多 400,000 个不同资源；页面、JSON 与时间界限保持。需要独立扩展、受限 operator 和实际采用验收，不因网站代码更新自动安装或切换。

执行前按私有 `PUBLIC_CACHE_SYNC_LOCK_PATHS_JSON` 明确列出的六个**原锁文件**和原顺序，非等待取得现有业务锁；保留维护、手动运行、writer session 与 worker 各自实际文件名，不统一改成 worker.lock。有他人的锁则退出，不偷锁或停调度。数据库再次锁定并核对计划，发现 staging 租约、版本变化或共享 owner 地址则拒绝，不能调用会打断他人暂存的旧下架入口。

原锁的父目录可以位于既有私有配置根，不要求在 `.local` 内；必须全部已经存在、由当前用户拥有、只允许本人访问，并且是无符号链接的绝对规范目录。先验证全部输入，再独占创建原锁文件；缺父目录时停止，不创建替代目录。释放时核对 inode、设备及持锁内容，变化的原路径保留并报告，同时回收其他本项锁。缓存回执和消费者状态仍保留原 `.local` 路径限制。旧 `PUBLIC_CACHE_SYNC_LOCK_DIRECTORIES_JSON` 仅兼容确实全部叫 worker.lock 的工程场景，不能与原文件配置同时设置；实际安装采用文件配置。

实际执行在同一事务中写 deny、递增缓存版本并记录待清理事件；学习父页包含整个后代。之后清页面、列表、API、RSC 和全部原图／小图标签，再抽查目标、一个后代和一张图的四档网站地址。仅真实通过才报告 COMPLETE；写结果不明先读取已提交意图，绝不盲目重做。清理失败保留 deny，阶段与退出码让调用方看到待办；已清缓存但核验失败也不写成下架完成。

相同物理图片、不同 owner 地址可以继续供其他公开页使用，操作不删除 COS 对象。如果不同页面实际共用同一个 owner URL，计划会标记 `sharedOwnerUrl` 并拒绝执行；必须先建立独立绑定，不能为了让 B 正常而继续开放 A 的旧地址。本轮没有自动改写历史正文／创建这种绑定。约一分钟是上线验收目标；已下载、离线或冻结标签页中的副本无法擦除。

## 前端接入

Codex 负责根布局、middleware、HTTP／媒体、缓存及本机入口；Claude 负责页面和组件。

1. 去掉公开页面与学习笔记 layout 的 `force-dynamic`。适合 ISR 的页面可用字面量 `export const revalidate = 86399`；不要在 route config 中引用运行时变量。带 searchParams 的页面仍可能按请求渲染，但统一 DTO 已可跨请求复用，不宣称删一行即可全部静态化。
2. 页面继续只调用原有统一入口，不自行缓存 Token、来源快照或错误。后端数据标签已自动绑定。搜索、预览和错误保持原动态语义。
3. 相对日期的 now 改为客户端计算，避免缓存 HTML 的“几小时前”固定。保留已有主题、切换动画和 F21 的一次读取处理。
4. 根 html 的 `data-public-cache=tagged-v1` 标记仅在启用时出现。只装一个可见标签页的版本监听，建议每 30 秒读取 `/api/content/version`；返回 `{version:1,revision:"摘要"}`，源站内容只含摘要，托管 CDN 最多 15 秒。404 时停用；不要给每张图／每个列表各加轮询。
5. revision 改变时清客户端自建分页／列表缓存并 `router.refresh()`；恢复标签页可见时先查一次。新首屏到达前不要继续从旧内存页填回目标。离线／浏览器历史的副本不承诺即时删除。

## 安装与验收边界

B10 的[提交屏障候选](BACKEND_CACHE_COMMIT_PLAN.md)已按用户确认完成源码与隔离验收，新增独立扩展及摘要，安装后新路径默认关闭。自动事件可在同一事务的延迟阶段分配原 generation，业务数据与事件仍原子提交；显式 enqueue 与撤回保持同步。旧迁移与事件接口保持，真实安装、激活及维护 catalog 守卫接续仍须另行授权。

SQL 文件与 SHA 在 `database/public-cache-protocol.json`；由 CLI 创建独立迁移，构建和 CI 不应用。普通 `supabase db push` 会包含 migrations 目录的新文件，不把它当只读检查。本轮未执行该命令、安装、创建登录凭据、启用扩展或设置云变量。实际安装前还须核对数据库依赖、权限顾问、六锁输入、消费入口和回退；原运行包仍冻结。

安装前的目录检查已有私有单次检查工件：只读 PostgreSQL 系统目录，不读正文／图片／来源数据。比对冻结迁移摘要、六个核心关系及两个函数签名、十一项缓存函数的源码摘要／definer／固定 search_path、逐角色执行权限、两张表的 RLS 与直接访问、schema 权限及实际投影表的刷新触发器。检查三种状态：完全未安装、部分安装／不一致、缓存对象与审阅工程匹配；发现同名对象或权限变化先报告，不自动覆盖、补授权或重装。仅有签名不证明完整核心兼容，实际运行包和 schema 版本仍由来源拥有方提供对应回执。

该检查在只读事务中执行一条目录 SELECT，statement 上限三秒、lock 上限 250 毫秒，返回上限 32 KiB，结束回滚，不自动重试。由获准的管理连接运行，不为检查临时提升网站 reader。对象匹配也不等于可开启：还须验证表定义／单例状态、实际网站登录与独立控制账号、前端修正、六锁、受保护候选及清缓存链路。检查准备已在本机 PGlite 通过缺核心、未安装、角色碰撞、正确安装、只读执行及权限／函数／观察器变化等十六个场景；没有执行云端目录检查。

回退先停止本项消费者的后续唤醒并排空其在途请求，保留六锁的原拥有权及已有来源任务；固定新旧部署、清理目标和受保护访问能力，完成必要的四范围强制清理，再把网页入口恢复到已验收且未启用新模式的部署，确认页面、API 及旧直链仍遵守已提交 deny，最后撤下本次新增的网站配置。旧模式 purge 接口会关闭，不能向已经回退的正式 Origin 发请求并误报清理成功；未完成的下架须先按原计划恢复，不能改其身份绑定跳过核验。禁止先将 `nb_cache.state.enabled` 关掉而让仍启用新模式的部署继续服务。源端事务触发器与数据库能力暂时保留，只有确认所有新模式调用已停止后才能单独停用；不删 deny、事件、私有回执或共享 COS 文件，不运行 DROP／全量迁移回滚。已清除的缓存不尝试恢复为旧公开结果，旧浏览器副本的过渡限制继续记录。

本机证据包括真实受限 PGlite：角色不能越权、暂存／过期计划拒绝、课程后代、共享原件不删除、原子待办／回滚、未知写入和刷新失败恢复；真实 Next Node 原型验证查询隔离、重复读取复用、硬删除与版本下架。中间层直接缓存失败及初始原型缺清单的编译失败都保留，未弱化检查。

这些不是 Vercel CDN 命中或全球清理证明。前端接线后集中完成检查／构建；上线须另行确认一次正式方案，轻量测代表页／API 的首访和 HIT、成功发布刷新、一个获准测试页的下架及四档直接 URL、另一共享页继续可用。旧浏览器一天副本的过渡限制写进回执，不重跑全量同步／图片迁移。

## 路由资格键与缺失结果

N04 使用规范化后的受管目标作为资格键，等价百分号编码、重复和尾分隔符合并。无效目标直接 missing；合法目标的 missing、元数据空值及笔记资格 false 不写持久投影，provider 故障仍为 503。先验证原始签名，缓存写入／返回仍受原 generation、日期和读取预算约束，见[决定](decisions/2026-10-25-route-cache-key-policy.md)。

选中操作的固定策略标记隔离旧键，不清除已有负项或改变一天／发布刷新协议。重复不存在地址可能增加实时读取；源码交付不是实际安装、配置、purge 或上线验收。
