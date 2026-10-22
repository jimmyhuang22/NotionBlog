# 网站数据库读取与图片接入

已确认正文读库与普通图片动态地址的试验方案。`MEDIA_PROVIDER=notion` 需要先安装定位扩展并发布新带索引批次，提供服务端只读 Notion 配置；转换图仍需 Storage reader。默认 Storage 行为保留用于回归，启用条件见 [混合媒体说明](HYBRID_MEDIA.md)。

本指南用于网站端接入准备。Notion → 数据库 worker 负责完整采集和暂存；网站使用独立 reader，二者配置与会话分别管理。核心 SQL、DTO、同步 v1 与现有公开范围保持不变。

## 两个读取身份

数据库迁移中的 `nb_reader` 是 NOLOGIN 权限角色，网站另外使用仅继承它的受限 LOGIN。它不能直接访问 `nb` 私有表、调用 writer 或管理政策。部署管理员确认目标数据库和现有角色后，单独创建网站登录；密码只在受保护配置或管理员界面中设置，不写进 Git SQL 或历史查询。

```sql
-- Deployment-specific identity, not a change to the frozen content migration.
CREATE ROLE nb_website_reader LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 2;
GRANT nb_reader TO nb_website_reader;
-- Set its password privately before attempting a connection.
```

图片使用独立 Supabase Auth 用户，管理员为它设置 `app_metadata.notionblog_storage_role=reader`。不得从可由用户修改的 `user_metadata` 获取授权，也不借用 writer 用户或管理 key。已有私有桶策略允许 reader 读取，禁止新增、覆盖及删除；无需重新创建桶或更改冻结政策。

由管理员通过 Dashboard 或服务端 Auth Admin 接口建立已确认的专用用户，设置密码并取得固定用户 ID。无需向其他人发送邀请。管理凭据只用于初始化，不部署到网站；[创建用户](https://supabase.com/docs/reference/javascript/auth-admin-createuser)、[管理员更新用户](https://supabase.com/docs/reference/javascript/auth-admin-updateuserbyid)说明这些操作只适用于服务端。

## 服务端私有配置

真实环境放在受保护的内盘目录或托管平台秘密中。开发盘若不支持所有权，不在其中保存密码。可用 Node 的 `--env-file=/受保护的绝对路径/reader.env` 加载单次命令；网站进程在启动前加载同一文件。Next.js 的变量只能用于服务端，不加 `NEXT_PUBLIC_`，也不要在 shell、截图或日志中输出文件内容。

| 字段 | 用途 |
| --- | --- |
| `DATABASE_READER_URL` | 网站独立 LOGIN 的 PostgreSQL 连接串；不包含附加查询参数 |
| `DATABASE_TLS=verify`、`DATABASE_CA_CERT` | 校验证书与目标域名，保持当前数据库信任链 |
| `STORAGE_URL`、`STORAGE_BUCKET` | 固定项目的 HTTPS `/storage/v1` 地址与既有私有桶 |
| `STORAGE_API_KEY` | publishable key，或兼容的 anon key；不接受 broad secret/service_role key |
| `STORAGE_READER_EMAIL`、`STORAGE_READER_PASSWORD`、`STORAGE_READER_USER_ID` | 三项同时配置后启用独立 reader 的自动认证 |
| `STORAGE_READ_TOKEN` | 未启用自动认证时使用的静态 reader JWT；到期后需由操作者更新 |

自动认证三项只配一部分会明确报配置错误，不回退到旧静态令牌。`CONTENT_PROVIDER=database` 仅在获准的隔离网站验证进程中选择；配置准备不修改现有云站。

## 托管网站的连接模式

Supabase 会话端点适合持久客户端；Vercel 等临时实例采用共享池的事务端点（6543）。固定 reader 的用户名、密码和数据库不变，仍校验 TLS／主机和执行权限；只修改获准环境的服务端连接串，不把 worker、迁移或备份的长事务配置一起切换。[Supabase 连接模式](https://supabase.com/docs/guides/database/connecting-to-postgres)说明两种模式的用途和预处理限制。

当前 pg 查询不使用命名预处理语句，也不靠跨请求会话状态授权。选择事务模式后必须用同一账号复验内容读取、直接表／政策写入拒绝，再验证完整页面及有限并发；不能仅凭端口或健康响应宣称完成接入。

每实例池的 `max` 和 LOGIN 的 CONNECTION LIMIT 都不能替代 Supavisor 会话池的客户端上限。遇到 `EMAXCONNSESSION` 应对照项目池日志、部署环境及真实实例数量；不能为消除错误直接提高权限、取消连接限制或放松 TLS。无用的会话连接也可能跨函数暂停保留，Vercel 官方给出 [Fluid Compute 池管理](https://vercel.com/docs/functions/functions-api-reference/vercel-functions-package)；本次端点修正未增加该依赖或修改独立 worker。

## 短期图片令牌

服务端使用专用 reader 账户的密码会话取得 access token，并调用同项目 `/auth/v1/user` 复核真实身份和当前管理员权限。校验固定 UID、issuer、audience、authenticated 角色、reader 元数据和有效期；[getUser](https://supabase.com/docs/reference/javascript/auth-getuser)会向 Auth 服务器验证用户。

每个进程只在内存缓存 access token，过期前 60 秒重新认证，并将进程内并发请求合并为一次认证。Auth 请求及响应读取共用 10 秒预算，单响应不超过 64 KiB；服务端错误不进入公开响应。Storage 每次对象请求前再检查令牌角色与有效期。

不保存或共享 Auth 返回的旋转 refresh token，因此多实例不会争用 worker 的续期会话。专用 reader 用户需要允许并发会话；若项目启用单用户唯一会话，必须先另行选择兼容的部署方案，不能自动修改全局 Auth 设置。密码登录按 Auth 限流执行，冷启动及认证失败会增加认证请求，需要在实际部署测量。[密码登录](https://supabase.com/docs/reference/javascript/auth-signinwithpassword)、[会话与令牌生命周期](https://supabase.com/docs/guides/auth/sessions)。

## 只读预检

```sh
node --env-file=/受保护的绝对路径/reader.env scripts/check-reader.ts --config-only
node --env-file=/受保护的绝对路径/reader.env scripts/check-reader.ts --verify-access
```

第一项不联网，只检查配置。第二项验证真实数据库身份／权限和 Auth reader 身份，区分“读取身份已验证”和“当前没有可读批次”。输出只含匿名检查结果，不含连接串、账户、UID、令牌或私有正文。预检不写入内容、不续期 writer、不下载实际图片，也不发布。

## 网站 HTTP 验收

```sh
npm run website:check -- --base-url http://127.0.0.1:3000 --expect-unavailable
npm run website:check -- --base-url http://127.0.0.1:3000
```

未发布检查用于确认 API 明确失败、保持 no-store，并且没有返回演示内容。它无法仅凭 HTTP 响应证明当前 provider 或失败原因，须结合启动配置和 reader 预检证据。

正常读取检查覆盖动态列表、年份与分页、课程树、代表笔记／详情和站内媒体，记录匿名数量及请求耗时。只抽取少量代表内容，保持来源内请求、禁止重定向，并对请求数、响应大小和时间设上限；选中内容没有图片时明确记录跳过，不报告媒体验收成功。这不代替逐页内容比较或中国内地／海外网络验收。

## 发布与接入顺序

v2 默认下载器和 CLI 对已观察到的 socket／正文传输中断，以及 HTTP 502／503／504，最多执行三轮完整下载，间隔两秒／五秒。每轮继续沿用原下载器的已验证地址及重定向上限，重新检查 HTTPS、DNS／IP、TLS、格式与字节；这不表示总共最多三次 HTTP 请求。权限拒绝、其他 4xx、429／529 限流、证书错误、未知错误、坏图片和主动取消不触发新一轮，退避也响应取消。失败仍终止整批，不跳过内容。该包装只用于 v2，原同步 v1 不变。

v2 完整采集默认限制为 20,000 个媒体引用和 1 GiB 去重图片字节。确需完整读取更大的已授权来源时，可在独立 worker 的私有环境设置 `WEBSITE_MEDIA_MAX_BYTES`（字节整数），最多 2 GiB；不配置仍沿用 1 GiB。该选项对应 `runWebsiteSync` 的 `maxMediaBytes`，成功回执另给 `mediaByteLimit`。数值无效或超过硬上限时，在读取来源、下载或取得租约前拒绝；累计超限仍失败整批并保留旧指针。单图 20 MiB、格式／SHA／来源检查和引用数量限制继续生效。此为每批完整媒体预算，不是网站响应上限或普通图的云存储用量；普通 Notion 交付仍不上传其原图。设置更大预算不启用云端同步，实际托管配置按用户授权执行。

1. 当前可独立完成 reader 配置、令牌认证与离线／未发布状态验证。
2. 收到 worker 严格全量 dry-run、stage 和对象回读证据后，再安排明确获准的新完整 publish。stage 本身不改变 `current_run`；网站不能读取暂存批次。
3. TTL 从 begin 开始计算，验收使用新鲜且已发布的完整批次。先验证隔离本地网站，再按授权安排受保护预览。
4. 页面、API、图片、撤回／过期与实际媒体字节均验证后，继续备份恢复、费用、国内外网络和运行周期验收；正式 provider、域名与调度按后续明确指令推进。

真实 reader 凭据、托管网络、实际图片和长期续期的证据分别记录。离线测试不能替代这些验收。
