# 同批次小图的 SQL 登记入口

执行者：Codex。用于第一次 published 全量发布后，把已经托管并由独立 reader 核对过的小图登记到**同一次 accepted full**。它不会采集 Source、生成小图、读取／上传对象或启用发布模式，不安装迁移或运行包。

## 输入和计划

```sh
node scripts/website-incremental-sync/thumbnail-registration-cli.ts plan \
  --config /PRIVATE/source.json --artifact /PRIVATE/same-accepted-full.json \
  --thumbnails /PRIVATE/candidates.json --coverage /PRIVATE/verified-coverage.json \
  --coverage-receipt /PRIVATE/original-verified-receipt.json \
  --duration-ms 480000 --sql-request-bytes 2097152 --sql-response-bytes 4194304
```

`plan` 只读取私有文件，无连接、锁、进度文件或云请求；`--help` 不读取输入。来源、accepted full 和候选沿用 [独立媒体验收](INDEPENDENT_MEDIA_ACCEPTANCE.md) 的输入。候选文件为 `media-acceptance-thumbnails-v1`，默认最多 197 条。更大集合须显式提供同一份[小图范围文件](THUMBNAIL_SCOPE.md)，并重新审阅计划；默认行为与旧计划摘要保持。

覆盖证明由媒体／发布拥有方从已有**独立 authenticated reader 成功回执**导出并审阅，格式为 `published-thumbnail-verified-coverage-v1`：

| 字段 | 含义 |
| --- | --- |
| `origin`、`prefix` | 已验证的 COS 固定目标；前者是 HTTPS origin，后者是对象前缀 |
| `receiptSha256` | `--coverage-receipt` 实际文件字节的 SHA-256，不能用模板或 PUT 回应代替读回回执 |
| `independentReaderVerified` | 必须为 true；这是拥有方的审阅证明，不是登记器自行访问 COS 的结果 |
| `objects` | 默认最多 197 项，每项仅有 `sha256`、`byteSize`、`mime=image/webp`；SHA 唯一、正整数字节，默认总大小最多 3,886,392 字节；显式范围时按其 maxObjects／maxBytes 验证 |

登记器校验这份审阅输入、原回执摘要与候选指纹一致；**不会解析任意第三方回执格式来独立证明 COS 现在可读**。拥有方须保留真实回执，不得把未确认的 PUT、失败请求、未知 TLS 状态或历史上传意图转成成功证明。登记之后仍必须执行独立字节验收。

计划先验证完整来源／目录／媒体成员关系，再排除非本次成员、父 SHA 已变化以及缺少匹配覆盖证明的小图。保留全部当前 owner／祖先检查，不通过对象去重丢掉所有者资格。计划摘要绑定当前 revision/config/epoch、候选、覆盖证明摘要、目标、预算及原回执摘要。输出只有摘要和计数。

## 登记与恢复核对

`register` 与 `verify` 还必须提供：

```sh
--plan-sha256 REVIEWED_DIGEST --runtime /PRIVATE/canonical-runtime.json \
--state-dir /PRIVATE/canonical-root/state --receipt /PRIVATE/fresh-operation.json \
--deadline-ms ABSOLUTE_UNIX_MILLISECONDS
```

新进度文件只允许首次排他创建，旧文件不可覆盖来重试。`state-dir` 必须与原 `website-v2-runtime-1` 的 `privateRoot/state` 完全一致；仍使用原 `worker.lock`，不抢锁／新建另一锁空间绕过 writer。运行前由原发布拥有方完成 writer／云租约交接；文件锁不是云租约证明。绝对 deadline 与相对预算同时生效，不能每阶段重置计时。

环境仅需 `SYNC_DATABASE_URL`、`SYNC_READER_DATABASE_URL`、验证 TLS 与可选 CA。拒绝禁用 TLS，拒绝 Notion Token、COS Key 与 Storage writer/refresh Token。实际打开两条固定 pg Client；独立 reader 使用服务器默认只读。完整 LOGIN／成员图、私表访问、CREATE 权限、允许 API、同一数据库与租户分别核验。数据 API 与宽权限账号不参与。

首次写入之前核对完整成员集合、双方相同发布状态、每个选中父图与已有变体。已有相同变体无需再写，冲突变体使整步在首次写入前停止；没有覆盖或父图变化的候选不能登记。只调用已有 `nb_publication_api.register_thumbnail`，服务端继续检查 revision、祖先公开资格、parent SHA、尺寸、收益及不可覆盖规则。

每项 RPC 前保存 `inFlight` 和请求数；得到回应后保存确认数；最后由独立 reader 核对所有选中变体、完整成员与双方状态，才返回 `registered-verified`。每次失败都可能留下部分已登记数据；`possiblePartialRegistration` 特指尚未确认的请求，并不证明其余已确认写入不存在。收到未知回复时停止，不自动重发，不删历史登记。`verify` 使用同一审阅计划，只核对，无登记写入；它是另一次受控操作，需从剩余预算／新授权明确安排，不能当成自动追加的免费重试。

## 停止预算与验收边界

选中绑定数为 M，保守 SQL 调用上限为 **18 + 3M**，默认197 项最多 609 次，低于旧方案的 640 次；更大显式集合按实际M计算，不能套用旧640次执行预算。包含双方 profile、扩展能力、状态／成员前后核对与每项登记／读回。幂等重复及 verify 实际少用登记次数。输入参数与 SQL 文本 JSON 最多 2 MiB，结果 rows JSON 最多 4 MiB，单次最多 8 分钟；范围扩展不提高这些限制。失败预留不退款；取消后关闭两条连接、等待实际挂起调用结算，再写最终计数，保留原语句／查询超时。

所有 HTTP 额度为零，原 fetch 与 HTTPS 端口也安装零额度守卫；这是现有端口的限制，不是通用网络沙箱。SQL 字节统计不包含 PG 认证／错误帧、TLS 或计费流量。失败或关闭／回执保存异常都不能报告完整验收。

`registered-verified` 只证明当时数据库关系正确。它不证明对象物理字节、完整所有原图覆盖或访客页面可用。接下来使用同一选中候选集合进行 [PR267 独立媒体验收](INDEPENDENT_MEDIA_ACCEPTANCE.md)，再做代表访客验收；全部留在原维护窗口，不能另加时间。真实工件、媒体覆盖、具体预算及运行授权齐备之前，此入口只供离线准备。
