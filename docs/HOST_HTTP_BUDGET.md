# 完整发布与增量入口的 HTTP 上限

`scripts/website-incremental-sync/guarded-cli.ts` 在加载实际 CLI／SDK 之前安装请求计数，再调用已有的[首次完整入口](FULL_BASELINE_HOST.md)或[增量入口](INCREMENTAL_HOST.md)。它不串行启动下一阶段、不重新采集、不配置政策，也不安装运行器。既有运行包不会因合并代码而自动使用此入口。

## 首次发布与日常更新

`publish`、`run` 必须显式提供四个 HTTP 上限及原 CLI 的 `--duration-ms`：

```sh
node scripts/website-incremental-sync/guarded-cli.ts publish \
  --http-notion-requests 5000 --http-storage-requests 10000 \
  --http-image-requests 5000 --http-total-requests 20000 \
  --config /absolute/private/sources.json \
  --lock-dir /absolute/private/canonical-state \
  --artifact-dir /absolute/private/one-full-run \
  --duration-ms 5400000 --source-requests 5000 \
  --source-bytes 268435456 --media-bytes 8589934592 \
  --max-media-bytes 2147483648
```

这组数字来自首次切换预算草案，**不是执行授权**；实际运行仍须绑定已审阅的来源摘要、冻结代码、原 canonical 锁、凭据和具体窗口。日常 `run` 使用原增量 CLI 参数和更小的已批准上限，不沿用首次完整预算。

本入口的来源命令当前只支持显式 `STORAGE_PROVIDER=cos`，对象请求分类的 origin 从现有 `COS_BUCKET`／`COS_REGION` 推导。Supabase 会话、续期和 Storage HTTP 尚未在此分类中获准；输入其他 provider 在分配连接前拒绝，不把其请求归入图片。原 CLI 的其他 provider 能力保留。

Notion、该 COS origin、外部原图分别累计，同时受总数限制。每次尝试在传输之前同步预扣，失败不退款，不引入重试；并发超额不会进入 transport。`fetch` 与原生 HTTPS 共用同一份计数；`https.get` 和 ESM 命名导入也受约束。原图片下载器的 IP 固定、Host／SNI、TLS 验证、回调和响应处理保持。

`fetch` 禁止自动重定向，避免内部跳转漏计；原安全图片下载器仍通过逐次计数的 HTTPS 处理跳转。非 HTTPS、URL 凭据和外部图片的非 GET 请求拒绝。包装期间新请求使用同一截止和取消信号；超额或到期还触发原 CLI 的 SIGTERM 取消处理，避免缓存命中后的处理继续提交；正常退出后恢复传输绑定。自定义 fetch 若内部也使用原生 HTTPS，可能保守多扣，不能少扣。

## 封存、初始化与恢复

这三个命令固定所有 HTTP 上限为零，不接受 HTTP 覆盖参数：

```sh
node scripts/website-incremental-sync/guarded-cli.ts seal \
  --config /absolute/private/sources.json --lock-dir /absolute/private/canonical-state \
  --artifact-dir /absolute/private/one-full-run --duration-ms 120000

node scripts/website-incremental-sync/guarded-cli.ts initialize \
  --config /absolute/private/sources.json --lock-dir /absolute/private/canonical-state \
  --runtime-dir /absolute/private/incremental-state \
  --artifact /absolute/private/one-full-run/incremental-baseline.json --duration-ms 899000

node scripts/website-incremental-sync/guarded-cli.ts recover \
  --config /absolute/private/sources.json --lock-dir /absolute/private/canonical-state \
  --runtime-dir /absolute/private/incremental-state --duration-ms 120000
```

promote 回复丢失时保留原准备工件，用 `seal` 独立查明同一提交；不能再次 `publish`。`initialize` 消费这份被接受的工件，既有程序核对实际数据库状态、全部 raw 内容及媒体描述，再安装两份缓存和目录。增量提交不确定时先 `recover`，保留原 lookup／读回／缓存安装规则，不重发提交。

`full-status --artifact-dir ...`、`incremental-status --runtime-dir ...` 调用原状态校验，仅输出聚合；`--help` 无 I/O。除 help 外，调用完成后追加 `format=host-http-budget-v1` 的计数与固定失败码，不输出目标、路径、来源 ID、正文或凭据。外层运行者应保留该行，不能仅看被底层适配器概括后的错误码。

## 验证和切换边界

HTTP 上限与既有来源响应字节、媒体预留／独立集合、时长限制同时生效；不替代 SQL 的权限、连接超时或维护／回退预算，也不是通用网络沙箱。当前实现覆盖现有 fetch 与原生 HTTPS 端口。独立媒体验收、访客访问和回退发布仍需分别冻结 HTTP／SQL 次数及字节上限。

离线组合验证实际 CLI、Notion SDK、COS 签名适配及 PGlite SQL：完整 promote 已提交但回复丢失后，重复 publish 在来源前拒绝；seal → initialize → recover 不产生 HTTP、不再次 promote。另验证耗尽额度时保留已发布状态、实际图片下载器的原生计数，以及并发、失败、截止、取消、重定向和绑定恢复。测试使用虚构来源、对象响应及本地数据库，不代表真实云 TCP／TLS、媒体覆盖、全课程采集或线上切换已完成。
