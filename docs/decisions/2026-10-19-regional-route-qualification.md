# 2026-10-19：资格查询改由普通区域函数执行

用户同意继续优化学习项目首次进入，落实固定数据区域的服务端资格入口。本项补充并取代 [2026-10-17 地域兼容方案](2026-10-17-proxy-supported-region.md) 中“middleware 地域配置已证明执行位置”的结论：正式运行的资格 SQL 仍在另一地区，平台接受配置与部署元数据均不能代替实际日志。

保留现有 Node middleware 文件和九条 matcher，先用纯函数识别无需数据的地址；需要读取的资格交给 `/api/internal/route-qualification` 普通 Node Route Handler。仅这一普通函数配置单一数据区域。服务复用原有统一 content 入口、项目目录资格、原子课程／笔记所属关系检查和 provider 错误语义，返回固定的 found、missing、unknown，不返回 DTO、正文或原始错误。不改数据库、连接池、页面组件、公开范围或来源配置。

每次 HTTP 请求重新检查资格，无跨请求正缓存，无失败时的直接数据库回退。内部 POST、返回和中间层 fetch 都不缓存；单次传输预算五秒、不重试、不跟随重定向，并校验协议、部署标识及响应大小。错误或不确定结果继续重写到 HTML 503，已确认缺失重写到 HTML 404；页面自身读取仍保留资格检查。

服务请求使用经过配置允许名单验证的来访 origin，保留同域部署保护 cookie 和既有 bypass 授权。允许名单来自当前部署／分支系统变量，正式部署另允许主域和已有 SITE_URL；预览不允许借用正式域。忽略 Host、转发 Host 和访客的版本头，平台已启用 Skew Protection 时使用当前部署 ID，同时校验响应部署，避免资格来自另一个版本。未知别名和版本错位均失败关闭，不放宽部署保护或增加凭据。未来添加域名时同步检查允许名单。

本机 Next 16.4 文档已弃用 preferredRegion，不使用该导出；普通函数地区由 vercel.json 配置。局部与完整本机检查、生产 HTTP 和本机平台打包只能证明行为及产物；还需获准的真实平台部署验证配置接受、服务实际地域、受保护预览、正常／缺失／错误路由及端到端耗时。会增加一次内部 HTTP 请求及函数调用，收益须实测，不能把本机耗时冒充云端优化结果。本次继续授权不包含另一次生产发布。

依据：[Vercel 普通函数地区配置](https://vercel.com/docs/project-configuration/vercel-json#functions)、[同域服务端请求与部署保护](https://vercel.com/docs/deployment-protection#how-to-migrate-to-standard-protection)、[Skew Protection](https://vercel.com/docs/skew-protection)。
