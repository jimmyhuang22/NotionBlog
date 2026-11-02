# 独立自托管入口

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

## 正式版本安装

AWS当前使用完整Node产物人工部署，没有Git自动发布任务。完成main发布后，核对正式提交与受检文件树一致，在对应Linux架构离线构建公开产物，再安装到独立release目录并切换服务；合并main本身不会更新AWS程序。保留受保护运行配置在代码之外，图片继续由既有云端存储读取，不打包私人配置、后台任务或媒体库。启用systemd开机启动，重启后仍须使用专用入口，普通 `npm start` 仍是离线演示。

入口变化先保留临时回退，逐项核对源站TLS、两层防火墙、代理目标端口和DNS，最后撤回临时跳转。首次切换如失败，先恢复回退，再修正并有限复验；不要停掉已有其他服务或关闭整层防火墙。

## 构建与配置

```sh
npm run build:self-hosted
```

构建及其 Node 子进程使用虚构内容并阻断外部连接，不加载 reader 文件；保留服务端追踪隐私扫描。产物不将 mock provider 写成编译常量，启动时才从受保护配置选择数据库。`.next/notionblog-self-hosted.json` 绑定 BUILD_ID 和服务器配置摘要；普通构建、编译固定 provider 的旧包或改动过的产物不能通过启动检查。

参考[配置示例](../config/self-hosted.example.json)，把真实 JSON 保存到代码之外或忽略的 `.local` 中。文件须为当前用户所有、权限0600、普通文件且只有一份硬链接；不接受符号链接。数据库 URL 不能附带覆盖 TLS 的查询参数；CA 为 PEM 字符串，必须匹配服务器证书和实际主机名。

初始版本只接受 database v2、qualified 发布读取和 configured 连接。网站 LOGIN 为 nb_website_reader，继承冻结的 nb_reader，不能有额外角色、私表或写入权限。社交可选，使用独立 nb_social_reader，沿用其严格身份检查。启动先完成有时限的身份/权限核验，失败不监听网站，也不回退 mock。

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
