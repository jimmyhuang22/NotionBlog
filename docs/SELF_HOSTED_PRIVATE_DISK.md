# 私有磁盘与受保护的试运行

这些能力默认关闭；原有 Supabase／COS 和 legacy 路径保持原样。主机配置、数据安装、Tunnel／Access、域名和正式发布仍由各执行阶段批准。

## 私有磁盘

在自托管 `public-website` 配置中显式设置：

```json
{
  "STORAGE_PROVIDER": "private-disk",
  "THUMBNAIL_STORAGE_PROVIDER": "private-disk",
  "MEDIA_DELIVERY_MODE": "display-only",
  "MEDIA_PROVIDER": "storage",
  "DATABASE_CONTENT_VERSION": "2",
  "PRIVATE_MEDIA_ROOT": "/srv/example/content-objects",
  "SOCIAL_MEDIA_STORAGE_PROVIDER": "private-disk",
  "SOCIAL_MEDIA_PRIVATE_MEDIA_ROOT": "/srv/example/social-objects"
}
```

上述只是受保护配置 `environment` 的新增字段，完整配置仍须满足读者隔离、PG 身份和 TLS 校验。网站 reader 只读；上传程序可使用独立 writer 适配器，其 `put` 只接受不可变对象。

每个目录采用 `0700`、对象文件采用 `0600`，归运行该适配器的系统用户所有。文件名为完整 SHA-256，没有扩展名；不能直接把旧展示包的 `objects/*.webp` 当成此目录。准备阶段须按已核清单复制并校验对象，安装阶段再配置只读挂载／写入身份。网站进程须通过只读挂载或 systemd `ReadOnlyPaths` 获得操作系统层的只读限制；受限上传账户只调用按对象校验的接收器，不获得文件所有者的任意 shell。读写服务可按文件所有者身份运行，但各自的挂载／服务权限不同。这些主机权限须在安装阶段验收。本次不会自动创建目录或迁移文件。目录必须是绝对真实路径，位于 `public` 外；拒绝软链接、硬链接、损坏内容和放宽的权限。

内容路由继续用数据库 display 协议决定资格和展示档位，读取后再核资格；最大宽度为 1600。社交路由继续用自己的资格查询及 original／400／800 描述符。两者均不通过缺文件回源；社交 original 不等于正文原图。

## 试运行入口

只有配置 `PREVIEW_ACCESS_CONFIG` 的独立试运行进程启用 Access JWT 校验。主域进程不设置此项。试运行进程只接受配置中的精确 Host，不能通过修改 Host 或 X-Forwarded-Host 绕过；HTTP 各路径与 WebSocket upgrade 均先检查。

配置文件为同用户、单硬链接的 `0600` JSON，结构如下：

```json
{
  "previewHost": "preview.example.test",
  "issuer": "https://example.cloudflareaccess.com",
  "audience": "应用的64位十六进制audience",
  "expiresAt": 0,
  "keys": []
}
```

此示例故意不能启动。执行阶段须取得对应应用的有效 RSA JWKS，填写密钥 `kid`、`kty`、`n`、`e` 和密钥缓存截止时间。服务校验 RS256 签名、issuer、audience、应用 token 类型及有效期；不接受客户端指定的密钥 URL。密钥缓存过期或未知 kid 时拒绝请求，更新受保护配置后重启。当前实现不会自行联网获取／刷新 JWKS；真实密钥轮换和 Cloudflare 服务令牌链路仍须在获准的试运行验收中验证。

Cloudflare Tunnel／Access 是第一层，源站校验为第二层。机器访问仍需 Access 侧的 Service Auth 策略及服务令牌，并提供有效的 `Cf-Access-Jwt-Assertion`；仅发送 client id／secret 不构成源站授权。

试运行配置要求 `SITE_URL` 对应上述 Host、`SITE_INDEXING_ENABLED=false`、`PUBLIC_CONTENT_CACHE=disabled`。可设置 `PREVIEW_DATA_DATE=2026-10-30`，页面显示“试运行数据截至 2026-10-30，社交统计未追平；看大图最大 1600 像素。”关闭试运行时移除这两项，主域不强制 Access。
