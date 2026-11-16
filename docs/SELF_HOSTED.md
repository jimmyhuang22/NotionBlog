# 独立自托管入口

当前生产目标及安装顺序以[生产部署与交接](PRODUCTION_DEPLOYMENT.md)为准：新加坡 Oracle 为主，AWS 保留但不再更新。本文的云端数据库、Nginx 8443 与默认配置示例描述可选拓扑和旧 AWS 用法，不是新加坡现役配置，不能据此改写线上入口。

专用入口为同一 Next.js 工程提供常驻 Node 服务。普通开发、检查、构建、启动和 Preview 继续使用[离线隔离](DEVELOPMENT_ISOLATION.md)，Vercel Production 保持现有行为。普通构建不读取线上配置。本入口提供服务程序，不自行安装数据库、迁移数据或切换域名。

## 复用现有云端数据库的公开网站

原入口默认保持不收录、关闭媒体的独立配置。公开网站须显式使用另一份构建和配置，不能在普通启动命令中伪装 Vercel 环境：

```sh
npm run build:self-hosted -- --public-website
npm run start:self-hosted -- --config /etc/notionblog/website.json --port 3100
```

配置使用[公开网站示例](../config/self-hosted-public.example.json)的 `deployment: "public-website"`，仍须为当前运行用户所有、0600、无符号链接及硬链接。它支持现有 Supabase 连接池地址、符合命名规则的轮换后网站只读账号，以及网站已使用的媒体、Notion 读取和社交配置；不接受数据库管理员、同步写入账号、Storage writer 或迁移变量。启动检查按配置中的实际 LOGIN 核对权限，连接池附加的项目后缀不会被当成数据库角色名。不会为迁移自动创建角色或修改权限。

迁移运行配置时，单独核对 `SITE_CONFIG_JSON` 中的站名、简介、头像、社交链接、`studyProjects` 学习项目和 `notionSiteUrl` 页脚入口，使用现行正式配置或用户已确认的私有备份。旧预览或历史部署目录中的配置可能仍含开发站文案，遗漏学习项目还会显示通用课程分组；通过结构校验不代表内容是当前正式值。原平台不可回读的 Secret 返回空值时，不把它当作空配置。仅修改这些运行字段无需重建，但须重启服务使新环境生效，并在正式域名核对文案、项目入口和头像实际加载。

公开构建仍用虚构数据并阻断外部连接，不加载真实配置；产物标记将公开和原独立构建分开，不能互换启动。公开模式不再附加开发浏览器 CSP 或统一 noindex 响应头，搜索引擎收录仍由受保护的 `SITE_INDEXING_ENABLED` 决定。所有栏目、来源与媒体公开边界沿用现有正式配置，不通过该模式增加来源。

公开模式默认关闭共享内容缓存；已安装的 `tagged-v1` 可显式沿用原站点键与签名密钥，并提供固定 `PUBLIC_CACHE_ORIGIN`。单进程部署可将网站内部资格请求固定到回环 Origin，消费者继续使用原有公开 Origin，两者不信任访客 Host。原 Next 数据／页面标签硬失效保持；已安装的 Vercel SDK 在非平台环境无 CDN purge 上下文时直接完成，不因此声称清除了 Vercel 或 Cloudflare 缓存。Cloudflare 动态页面保持不共享缓存；不要擅自启用页面缓存或改动现有消费者调度。验收需验证签名清理接口、内容读取与媒体；不在部署中制造数据发布或撤回。Node 堆上限为768 MiB，Linux 原生分配器 arena 上限为2；这不等于整个进程的内存上限。[systemd 示例](../deploy/self-hosted/notionblog.service)另给出整组进程的 CPU/内存限制，须根据目标机实测调整。

网站只监听回环端口，通过 HTTPS 入口对外提供服务。[Nginx 示例](../deploy/self-hosted/nginx.conf.example)将网站放在8443，保留现有443服务；Cloudflare 使用 Full (strict) 和只匹配网站域名的 Origin Rule，将源站目标端口覆盖为8443，安全组与主机自身防火墙均只允许 Cloudflare 当前网段访问该端口；不能只检查其中一层。不要覆盖已有服务或开放 Node 回环端口。构建必须在目标操作系统/架构对应的 Linux 环境完成，不能携带 Mac 的原生依赖。安装、扩容、DNS、真实连接及正式发布仍依照用户对该次部署的授权执行。

Nginx 需启用 `http_realip_module`。网站监听只信任来自 [Cloudflare 当前 IPv4／IPv6 网段](https://www.cloudflare.com/ips/)的 `CF-Connecting-IP`，再用解析后的地址覆盖传给回环 Node 的 `X-Real-IP` 和 `X-Forwarded-For`。安装时核对示例网段，并与安全组、主机防火墙已启用的地址族同步维护。网站访问日志首列继续记录 TCP 对端（公网为 Cloudflare 边缘），以免将恢复出的访客地址写入访问日志。验收需测试可信请求、伪造头和不可信来源的回退行为。

## 正式版本安装

新加坡 Oracle 当前使用完整 Node/Linux ARM64 产物人工部署，没有 Git 自动安装任务。得到当次授权并完成 main 发布核对后，再按[统一部署入口](PRODUCTION_DEPLOYMENT.md)准备产物与独立 release；合并 main 不会自动更新主机。现役使用 published/scoped 数据库读取与本地 display-only/private-disk 展示媒体，数据库页面保持 legacy。受保护配置、数据库、媒体库和私人后台任务均在代码发布之外，不从 AWS 包复制或覆盖。重启后仍须使用专用入口，普通 `npm start` 是离线演示。AWS 保留且不再更新，任何恢复或退役另需明确授权。

安装校验应在待发布目录内以网站账号运行；从部署用户的私有家目录启动Node校验，可能在模块解析时就因目录权限失败，应修正工作目录而不是放宽家目录权限。启动先核对只读身份／权限并准备Next，不能把端口尚未监听等同于版本损坏。公开且启用 tagged-v1 缓存的配置会在对外监听前，用临时回环端口先读取内容版本、再完整读取首页；启动预热最多等待十秒、累计响应正文最多 1 MiB，不取图片或其他栏目。只有首页成功读出首屏动态才记录 `self_hosted_home_warmup` 的 `ready`，失败则记录 `unavailable` 并继续启动，不延长现有访客／SQL 期限或反复重试。预热仍走正常版本、资格和撤回检查，缓存内的页面也必须先核对版本；这是把首次准备工作提前，不能宣称冷数据库计算消失。部署启动宽限须覆盖身份核验、Next 准备及这十秒上限。等待 `self_hosted_ready` 或给予明确的部署启动宽限再探测健康；连接被拒会立即返回，一秒间隔尝试三次实际上只等待约两秒。早期图片修复曾使用十秒部署启动宽限，见[历史验收](progress/2026-11-02-cover-request-fix.md)；首页预热发布改用二十五秒，覆盖新增预热，见[冷启动验收](progress/2026-11-03-home-cold-start.md)。部署宽限不改变访客请求或 SQL 期限。

任何新的入口切换须单独获准，并按实际拓扑核对 TLS、Tunnel／代理和 DNS。网站版本回退优先使用新加坡已验证的前一 release，不回退内容数据库或启动旧同步；AWS DNS 回退不是普通发布的默认动作，须按当次明确授权执行。用户要求失败停止时，不修复后自动重试。

## 构建与配置

构建前按[部署预检](PRODUCTION_DEPLOYMENT.md#构建与切换前预检)检查双锁依赖、构建用户目录权限和实际 Linux 内存约束；专用构建入口自动拦截这些失败。构建后另用网站运行账号执行 runtime 预检，不能用 root 的读取结果替代。

```sh
npm run build:self-hosted
```

构建及其 Node 子进程使用虚构内容并阻断外部连接，不加载 reader 文件；保留服务端追踪隐私扫描。产物不将 mock provider 写成编译常量，启动时才从受保护配置选择数据库。`.next/notionblog-self-hosted.json` 绑定 BUILD_ID 和服务器配置摘要；普通构建、编译固定 provider 的旧包或改动过的产物不能通过启动检查。

参考[配置示例](../config/self-hosted.example.json)，把真实 JSON 保存到代码之外或忽略的 `.local` 中。文件须为当前用户所有、权限0600、普通文件且只有一份硬链接；不接受符号链接。数据库 URL 不能附带覆盖 TLS 的查询参数；CA 为 PEM 字符串，必须匹配服务器证书和实际主机名。

仓库通用配置校验仍以 database v2、qualified 发布读取和 configured 连接为初始默认。源码另支持严格限定的 published 组合：必须是 public-website、数据库 v2、scoped 读取、legacy 数据库页面、storage/display-only 媒体、原图与缩略图均 private-disk、SELF_HOSTED_MEDIA_MODE 和共享内容缓存均 disabled。published 不支持 compact 页面、legacy 读取投影或云端媒体；已有 qualified 配置行为不变。仍须提供受保护的 PRIVATE_MEDIA_ROOT，启用社交媒体时也必须使用独立校验的 private-disk 目录；统计配置继续按原规则校验。

这项源码适配尚未发布到 main 或安装到主机，现役仍保留旧补丁；下一次获准发布须核对候选源码包含本项及现役实际差异，再使用正式源码替代补丁，不能因为开发分支支持就直接覆盖旧 main。实施与验证见[进度](progress/2026-11-14-published-private-profile.md)。网站 LOGIN 为 nb_website_reader，继承冻结的 nb_reader，不能有额外角色、私表或写入权限。社交可选，使用独立 nb_social_reader，沿用其严格身份检查。profile 接受配置不授予内容公开资格；启动仍先完成有时限的身份/权限核验，失败不监听网站，也不回退 mock。

作品首屏共同读取的 `DATABASE_LIBRARY_PAGE` 默认 `legacy`，保留原列表、年份读取与缓存。受保护配置允许显式设置 `compact`，但须同时使用 `DATABASE_READ_PROJECTION=scoped`，并先安装及登记独立的 `database/library-page-protocol.json` 协议。白名单支持不代表已安装协议或已启用；本项默认关闭，云端验收和启用仍需另行授权。

普通 PostgreSQL 中，冻结 REVOKE 语句引用的 anon/authenticated/service_role 需要无登录、无高权的兼容角色；不因此启用 Auth/Data API。数据库必须由既有安装器登记协议摘要，不能把直接执行所有 SQL 当作完整安装。完整迁移和媒体是后续验收项。

## 启动与本机验证

```sh
npm run start:self-hosted -- --config /private/notionblog/reader.json --port 3100
```

默认监听127.0.0.1。容器需要时显式指定 --hostname 0.0.0.0；宿主机端口与反向代理仍由部署配置控制。真实配置不进入构建或 next.env，旧 dotenv 不能加入额外来源。只有专用 Node preload 创建的进程上下文可以开启此模式，单独设置 dotenv 标记不能启用；拒绝与 Vercel/CI 混用。

仅使用本机虚构数据库时增加保护：

```sh
npm run start:self-hosted -- --config /private/notionblog/fixture-reader.json --port 3100 --local-only
```

--local-only 要求数据库为 loopback，启用已有 Node 外连保护，并禁止绑定所有网卡。本机也验证 TLS，不接受明文豁免。初始版本强制noindex、关闭共享公开缓存，reader隔离固定enforce；不要传入整份生产环境文件。

媒体默认关闭。可显式启用[只读展示图片](SELF_HOSTED_MEDIA.md)：`SELF_HOSTED_MEDIA_MODE=display-only` 与受限的 `SELF_HOSTED_MEDIA_ROOT` 一起配置，当前只允许关闭社交的环境。网站只读取Mac事先准备的展示副本，不取得原图、对象存储或Notion凭据。启动会先核对目录；真实文件安装与数据切换需另行验收。

## 退出与部署边界

独立 HTTP 启动器通过 Next 的程序化 API 处理原有路由，以便SIGINT/SIGTERM时先停止接收请求，等待在途HTTP及Next回调，再显式关闭登记的reader池。三十秒超时会报错退出；强制退出不算优雅关闭通过。容器停止宽限期须更长。Vercel继续注册平台生命周期，池大小、SQL、TLS及读取资格保持。

当前使用完整Node部署，不使用standalone输出；部署需携带启动脚本、Next构建与对应依赖。Mac原生依赖不能直接复制到Linux，镜像构建、导入和目标机器运行仍须验收。

验证应覆盖真实HTTP→TLS reader→PostgreSQL→DTO、失败不回退、坏证书/身份拒绝、在途排空与池关闭。本机演练不证明目标服务器容量、真实数据/图片迁移及国内外可达性；这些操作另行确认。

静态构建资源可按[独立静态入口方案](STATIC_ASSET_CACHE.md)走 8444，避免 Cloudflare 对既有 8443 的默认缓存限制。旧 AWS 站点已于 2026-11-03 经用户批准启用，只开放 `/_next/static/`，动态页面与媒体仍走原入口；两层防火墙限 Cloudflare 网段，公网 JS/CSS/字体双读 HIT 已验证。其他安装仍须按各自发布批准启用并验收，见[本轮记录](progress/2026-11-03-static-media-cache.md)。
