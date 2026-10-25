# 独立自托管入口

专用入口为同一 Next.js 工程提供常驻 Node 服务。普通开发、检查、构建、启动和 Preview 继续使用[离线隔离](DEVELOPMENT_ISOLATION.md)，Vercel Production 保持现有行为。本入口不安装数据库、不加载线上配置、不迁移数据或切换域名。

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
