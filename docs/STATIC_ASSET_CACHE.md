# 自托管静态资源缓存

本配置只处理构建资源，不缓存页面内容。本站已于 2026-11-03 经用户授权启用，JS/CSS/字体双读均验证 HIT/Age；见[验收记录](progress/2026-11-03-static-media-cache.md)。示例不会自动安装，其他部署仍需各自发布确认。

## 为什么需要独立入口

Next 已为 `/_next/static/` 的版本资源生成 `public, max-age=31536000, immutable`。在应用里重复加响应头无法解决 Cloudflare 回源端口的缓存限制。[Cloudflare 官方端口表](https://developers.cloudflare.com/fundamentals/reference/network-ports/)将 8443 列为默认禁用缓存的端口；Enterprise 才能用额外端口缓存选项放行。规则模拟与现场配置确认既有网站使用 8443，且无 Cache Rules、无 Page Rules、开发模式关闭。

候选方案为静态文件单独使用 8444 TLS listener，避开该禁用列表；Cloudflare 对外仍是 443，通过 [Origin Rule 目标端口覆盖](https://developers.cloudflare.com/rules/origin-rules/parameters/)回源。它是否在本站实际命中缓存，必须启用后取得 `HIT` 和 `Age` 才算通过，离线配置检查不能代替此验收。

## 启用步骤

1. 在现有 Nginx `http` 配置中额外包含 [nginx-static.conf.example](../deploy/self-hosted/nginx-static.conf.example)，仅替换站点域名并沿用当前证书。现有 443、8443 与 Node 回环监听不改。8444 只代理 GET／HEAD `/_next/static/`，其他路径拒绝，错误不强设缓存。
2. 确认 8444 未占用；安全组与主机防火墙都只允许现有 Cloudflare 官方网段进入 8444。先 `nginx -t`，再平滑 reload，回环 TLS 请求检查静态 200 和非静态 404。证书、Full (strict) 与现有 8443 回退入口保持。
3. 创建 [静态 Origin Rule](../deploy/self-hosted/cloudflare-static-origin-rule.example.json)，仅替换两个站点域名；必须排在现有网站 8443 规则之后，让静态路径最后覆盖到 8444。不要替换整个规则集。
4. 创建 [静态 Cache Rule](../deploy/self-hosted/cloudflare-static-cache-rule.example.json)，相同域名＋路径＋GET／HEAD 条件；Eligible for cache，Edge TTL 选择“有缓存头按缓存头，没有就绕过”，Browser TTL 选择 Respect origin。不加状态码强制缓存，不去掉查询参数，不更改站点全局缓存级别。字段依据 [Cache Rules 官方说明](https://developers.cloudflare.com/cache/how-to/cache-rules/settings/)。

## 上线验收与回退

- 从当前 HTML 取真实 JS、CSS、字体 URL，各普通 GET 两次；核对 200、类型与字节一致、源站一年 immutable 头，以及第二次 `CF-Cache-Status: HIT`／`Age`。不带强制刷新请求头，也不用随机查询参数造新键。
- 无此文件的静态 URL 应 404 且不被缓存；普通 HTML、RSC、API、`/media/` 和内部接口不得走 8444 或变为共享 HIT。图片成功响应应为五分钟 private，错误 no-store。
- 普通链接、后退／前进回访测试图片复用；五分钟到期后允许资格校验和 304。缓存淘汰或强制刷新不承诺零网络。
- 任一边界不符，先停用新增 Origin Rule 和 Cache Rule，静态请求即回到既有 8443；再撤去新增 listener 和两层防火墙的本次增量。不要清空全站规则、替换证书或改动既有服务。不能以增加全站共享缓存掩盖失败。

带内容版本的静态 URL 随构建变化，新版引用新地址；无需为发布清全站缓存。旧版本资源仅在节点仍保留时可用，资源保留策略不在本项扩大。
