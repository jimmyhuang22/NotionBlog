# 独立媒体迁移的离线预检

运行器和 COS 适配准备期间，可以先消费已有备份清单、压缩候选及退役回执，核对迁移容量。使用 `scripts/media-migration/cli.ts`，只读取本地 JSON 元数据；不会读取图片、连接来源或对象存储，也不会上传、删除或发布。

历史备份可能仍包含已经永久删除的对象。`retiredSourceKeys` 按旧对象身份排除这些行；`protectedSourceKeys` 保留正文共用原件，若与退役名单重叠或在清单里缺失则拒绝规划。未发现引用的图片仍保留为 `unreviewed`，不据此删除。图片审查和网站切换分别推进，不要求先审完所有未知引用。

输入是 `media-migration-inventory-v1`：

```json
{
  "format": "media-migration-inventory-v1",
  "assets": [],
  "retiredSourceKeys": [],
  "protectedSourceKeys": [],
  "limits": { "storageAvailableBytes": null, "transferBudgetBytes": null }
}
```

每个 asset 只含 `sourceKey`、`reference`（`current`／`historical`／`unreviewed`）、`original` 和 `candidate`。两个版本均含 `sha256`（64位小写十六进制）与 `byteSize`（正整数）。不压缩的候选与原件相同；压缩候选不能大于原件。相同摘要必须声明相同大小，重复旧键、冲突或未知字段直接失败。旧键是私有、精确匹配的身份，不作文件路径或请求地址。

文件必须是绝对路径下的 600 普通单链接文件，父目录为当前用户所有的规范 700 目录。输入最多16 MiB、20,000行。输出使用新文件，不覆盖旧回执、输入或符号链接：

```sh
node scripts/media-migration/cli.ts \
  --inventory /private/media/inventory.json \
  --output /private/media/new-plan.json
```

计划分别给原件和压缩候选生成按 SHA-256 去重的 `sha256/<摘要>` 对象清单、引用字节数、独立对象字节数，以及一次上传加一次完整回读的字节数。压缩候选只是容量比较，不表示视觉已批准或可以改写既有媒体描述；改动字节后必须重新核验 MIME、尺寸、摘要及发布映射。原件副本继续保留，现有已验小图继续复用。

容量参数必须来自具体目标的可用余量和本次批准的传输额度；未知时填 null，结果也为 null。即使两项比较都通过，`executionAuthorized` 和 `publicationScopeVerified` 始终为 false。一次上传加回读不含来源下载、重试、既存对象校验的额外传输、缩略图、访客出站、存储增长和请求费用，不能当作实际计费上限。超过当前20 MiB单图限制的对象单独计数，不能靠计划掩盖运行器限制。

控制台摘要只输出数量、字节和容量比较，逐项旧键与对象映射留在私有输出；输出还保存输入文件 SHA-256。证据等级始终是 `metadata-only`，已有清单中的摘要不等同于本轮重新核验了文件或远端对象。

下一步由媒体和主运行器拥有方使用实际获准发布集合核对缺项、目标 writer／reader、预算及维护窗口。历史图床保留集合不等同于全部课程的发布集合；首次完整采集可能包含新的 Notion 或其他网络图片。正式切换仍需同次完整发布工件、独立 reader 与原图／小图访问证明，并在阻断访客 Notion 请求后验证正常阅读。参考[重构上线准备](REFACTOR_ROLLOUT.md)和[图片预览副本](MEDIA_THUMBNAILS.md)。
