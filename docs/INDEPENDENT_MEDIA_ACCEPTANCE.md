# 独立媒体验收入口

`scripts/website-incremental-sync/media-acceptance-cli.ts plan|verify` 从[同次已接受完整工件](FULL_BASELINE_ARTIFACT.md)确定本次媒体成员，通过独立 reader SQL 和 COS GET 验证。它不采集来源、不上传／编码、不登记小图、不发布或回退，不接替既有图片执行器。与[完整／增量入口预算](HOST_HTTP_BUDGET.md)分别计数。

## 先离线确定清单

输入为私有来源配置、`incremental-baseline.json` 和小图候选 JSON，均为绝对路径、600 文件。小图文件形状为 `{ "format": "media-acceptance-thumbnails-v1", "entries": [...] }`；每项具有 `parentAssetId`、`parentSha256`、`widthCap`（400／800）、`thumbnail`（既有 StoredMedia 描述）。真实清单保持在忽略目录。

```sh
node scripts/website-incremental-sync/media-acceptance-cli.ts plan \
  --config /absolute/private/sources.json \
  --artifact /absolute/private/one-full-run/incremental-baseline.json \
  --thumbnails /absolute/private/thumbnails.json \
  --duration-ms 2700000 --sql-response-bytes 67108864 --control-bytes 1048576
```

plan 无 SQL／HTTP。它校验实际范围、完整状态、成员及媒体描述；父资产不属于该批次的历史小图单独计为排除，已匹配父资产的 SHA／尺寸／档位／字节冲突则拒绝。小图必须小于原图；不自动生成、挑图或扩大公开范围。计划只输出聚合与 `planDigest`，不输出路径、来源、资产 ID、正文或凭据。

设本批次原图资产数为 N，实际去重对象数（原图＋选中小图）为 U：

- HTTP 上限为 U，仅该 COS origin 的 GET；Notion 和外部图片上限为零。一次读失败计费，不重试，不跟随隐藏重定向。
- SQL 上限为 `11 + 4N`：角色／能力、两次状态和完整成员读取，再对每个资产的两个档位分别前后核对。
- 原图按对象去重最多 2 GiB；额外小图默认最多 15 MiB。大集合须显式提供与登记相同的[小图范围文件](THUMBNAIL_SCOPE.md)，最多128MiB新增小图，数量／字节限制纳入计划摘要。响应体上限为实际对象字节总数加显式控制响应额度（最多 1 MiB）。原图共享对象仍保留每个 owner 的资格检查。
- 显式时长最多 45 分钟，成功 SQL 行的 JSON 累计最多 64 MiB；不提供完整通过的默认执行许可。

SQL 行大小在驱动交付该次结果后检查；过限结果已收到，随后停止。图片每个已读取的响应块先计费再检查，最后一个过限块也保留计数。这些是程序的应用层预算，不能当作 TLS／PG 帧、错误包或平台账单的全部带宽上限。

## 使用独立读取配置验证

沿用 plan 参数，增加 `verify` 与 `--plan-sha256 REVIEWED_DIGEST`。摘要变化在连接分配前拒绝。实际执行需单次明确维护授权，冻结代码、输入、凭据和绝对窗口；计划输出不授予该权限。

verify 必须显式提供 `SYNC_READER_DATABASE_URL` 及 TLS／CA、`STORAGE_PROVIDER=cos` 和独立 COS reader 配置。只创建一个原生 pg Client，启动参数强制 `default_transaction_read_only=on`，继承现有证书验证、10 秒连接／15 秒 SQL／20 秒驱动超时；没有 writer 登录。同步媒体读取使用独立 `nb_delta_reader`，包含公开小图核验函数但不能写入；核对实际 LOGIN、全部角色成员、管理／所有权、私表与 API 权限。真实 TLS 与 COS IAM 独立读取资格仍按既有部署证据绑定，逻辑 reader 参数不代替 CAM 证明。

完整 page／media 成员必须等于该批次工件。每个原图的 400／800 查询核对当前政策、祖先与撤回资格、发布状态及完整描述；应有小图缺失、出现未审阅的有效小图或描述变化均失败。对全部 U 个对象验证 GET 的 MIME／长度／实际 SHA 与内容；读完后再次检查所有资产与成员和状态。不能只凭一份共享对象或 writer 回执证明多个页面公开资格。

截止／额度耗尽停止后续 SQL／HTTP并关闭 reader；退出保留失败尝试与已接收字节，不退款、不自动再跑。输出 `independent-media-acceptance-v1` 聚合回执，错误码、HTTP／SQL／字节计数须由运行日志保存。测试使用本地 PGlite、虚构图片／COS 响应及被替换的原生 Client 端口，不代表真实 TCP／TLS、COS 覆盖、国内访问或网站模式已验收。

## 与首次切换和回退的关系

顺序为完整 publish → 不确定时 seal → initialize → 此独立媒体验收 → 代表性增量／中断恢复与访客验收 → 安装／站点切换。此入口的成功只证明本次媒体读取；缓存安装、访客不连接 Notion、地区访问和整轮回退各自留证据。

在原项目更改政策会使旧 qualified 批次失效，恢复旧政策或 env 不能恢复旧资格。回退必须由冻结的旧范围运行包进行一次新发布，再独立读回；不删除新指针、对象或证据。实际旧运行入口虽有 90 分钟和 2 GiB 去重集合上限，来源尝试／累计传输仍须另行冻结约束；失败中的旧 publisher 不能作为已证明可用的回退。维护和回退窗口、单一 canonical writer 交接及具体执行授权继续由[切换检查点](REFACTOR_CUTOVER_CHECKPOINT.md)核定。
