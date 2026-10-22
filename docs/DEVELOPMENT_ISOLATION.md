# 本地开发与真实云端联调

普通 `npm run dev`、`npm test`、`npm run check`、`npm run build` 和 `npm start` 明确使用演示内容与演示作品，读取本机 fixtures／public/mock-media。数据库回归使用隔离 PGlite；素材位于项目所在 SSD，不需要重新从生产 Storage 下载。此默认不是个人生产库的完整浏览副本，也不自动解密恢复包。Next 在加载 `.env*` 后再次清理真实 provider、凭据和私人站点配置；旧 `.env.local` 不能让这些入口自动连接正式库。直接运行 Next dev/build/start 也采用本地默认。真实 provider 报错仍然失败，不会悄悄改为演示。

开发进程与继承的 Node 工作进程限制服务端 TCP／HTTP／TLS／fetch 到 loopback，保留本机开发服务、数据库和 Unix socket。它不是操作系统防火墙，不能约束另开的 curl、浏览器访问第三方、修改启动代码或任意非 Node 程序。默认演示头像及图片均不需要真实云端；不要把私人数据复制进可提交的 fixtures。本地数据库协议测试继续使用隔离 PGlite；本轮不安装常驻 PostgreSQL 或复制生产数据库。

```sh
npm run dev
npm run dev -- --port 3100
```

服务只绑定 127.0.0.1。启动输出明确写明离线演示，索引关闭。测试与构建启动器在子进程开始前排除父环境凭据，并预留所有 dotenv 键，防止生产环境文件在构建阶段恢复凭据；子工作进程继承 Node 网络守卫。CI 的 check/build 使用同一入口，不能因意外继承 Vercel 标记成为真实构建。依赖安装仍可能访问 npm registry，这不属于生产数据读取。

## Preview 与正式环境

新代码的 Preview、自定义环境及缺失环境标记的部署默认离线。Next 配置处理构建阶段，instrumentation 在每个新的 Node 服务实例接收请求前再次清理，避免只隔离构建而遗漏 serverless 运行阶段。浏览器 CSP 将图片、媒体和接口限制在本站；不因私人头像或残留远端图片地址访问生产 Storage，第三方 iframe 关闭。Next 本地热更新 WebSocket 仅允许 loopback。

只有明确的 `VERCEL=1`、`VERCEL_ENV=production`，且 `VERCEL_TARGET_ENV` 缺失或同为 production、非 GitHub Actions 时，保留平台正式 provider 与凭据。不能用 `NODE_ENV=production` 单独启用真实环境。正式网站原身份、RLS、TLS、缓存及来源资格不变；在其他托管平台正式运行需要另行设计明确的生产入口，不能靠默认本地启动绕开隔离。系统变量依据见 [Vercel 官方说明](https://vercel.com/docs/environment-variables/system-environment-variables)。

这些是源码保护，需相应版本实际部署才影响该部署。旧 Preview URL、旧检出及之前已启动的服务器不会自动改变；本项不自行部署、删除旧部署、下载环境秘密或改变业务调度。使用新的固定离线入口可保护旧检出的 Node 服务，但浏览器 CSP 需要相应 Next 配置。真实云端代码不进入普通 Preview，有限联调使用下述本机入口。

## 有限真实联调

真实联调使用独立的 owner-only reader 文件和 owner-only JSON 计划，不继承普通目录的未选中真实 `.env` 项、不转交 writer／migration 凭据，也不自动启用社交来源。必须显式同意本次云端连接和指定 1–900 秒的会话期限；缺少计划或上限即拒绝启动。示例计划中的主机是虚构值，实际计划与凭据保持私有：

```json
{
  "version": 1,
  "paths": ["/"],
  "destinations": [{ "host": "reader.example.invalid", "port": 6543 }],
  "maxRequests": 2,
  "maxConnections": 4,
  "maxReceivedBytes": 1048576
}
```

```sh
npm run dev:real -- --env /private/path/reader.env --plan /private/path/plan.json --allow-cloud yes --duration-seconds 300 --port 3100
```

私有文件中选中的真实 provider 保持原错误语义，身份／TLS／RLS／撤回检查不变。需要某个来源时明确写入其 reader 配置。环境项由 Next 在 dotenv 后再次按本次名单筛选；不能靠工作目录已有的社交凭据意外加入真实社交读取。

只有固定路径及查询字符串的 GET 可以到达 Next；POST、未登记分页、图片、RSC／预取请求被拒绝。静态 JS／CSS 可读取，不计入样本请求。最多 20 个样本请求、32 次远端连接、16 MiB 远端接收字节，不是默认必须花完的额度。`maxRequests` 统计页面／API／媒体样本请求，不冒充 SQL 语句计数。未在 destinations 中登记的远端 TCP 目标在 DNS 前拒绝，不自动跟随到新云主机；本机 loopback 保留以供 Next 内部通信。只从显示的网关端口验收，不直接访问内部 Next 端口。

Next 及其 Node 子进程的已登记远端连接经同一个本机中继；远端返回的 TLS／PG／HTTP 传输字节累计，命中读取上限即断开所有连接并终止本会话；连接与样本次数在下次开始前检查。到期先终止进程组，2 秒内仍未退出则强制终止，防止只停父进程却遗留 worker。终止输出只含计数和原因，不含路径、正文或凭据。没有自动重试、扩大清单或恢复下一轮。

本机中继计数不是 Supabase 精确账单，也不是平台额度硬开关：触发上限的那一块数据可能已经传到本机，尚在途数据和其他客户端不受此会话控制。Node 守卫不是操作系统防火墙，不约束另开的浏览器、curl、非 Node 子程序、恶意修改代码或通过其他本机代理访问云端。正式访客、采集和另行批准的备份仍独立产生正常费用。只有同任务的明确有限联调才能使用此入口，不能将旧批准当成永久允许访问。实际验证优先复用同版本结果，不重复整页图片或整库导出。计费范围见 [Supabase Egress 说明](https://supabase.com/docs/guides/platform/manage-your-usage/egress)。

## 社交事务池候选

现有 `SOCIAL_READER_CONNECTION_MODE=configured` 保留原 URL 和实例连接数。显式设为 `transaction` 时，仅接受已给定的 Supabase shared-pooler 主机、带项目后缀的原 nb_social_reader 身份、5432／6543 端口；只切换到同主机 6543，实例池最多一条连接。保留原密码、严格 TLS、查询超时、权限验证及 RLS。未知主机／模式／端口、身份替换或 URI 参数拒绝，不能猜测一个新数据库地址。

该配置不修改数据库对象、角色权限或连接限额，也不建立资格缓存。先对新端口有限验证实际身份、角色／能力和代表 RLS 读取，再为对应正式发布单独切换配置。回退为删除此配置或改回 configured；原地址不改。事务池只解决连接复用，不自动减少数据库返回字节。

官方依据：[Supabase 连接方式](https://supabase.com/docs/guides/database/connecting-to-postgres)。
