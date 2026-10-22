# 网站发布与小图接入交接

本说明衔接网站发布、小图处理与 Claude 页面验收。内容仍经统一 DTO 与服务端入口读取；小图生成使用既有[增量流程](MEDIA_THUMBNAILS.md)，不另建页面接口。真实批次、地址、私有文件位置与实际资格截止只记在忽略的本机交接中。

## 分工

| 负责人 | 交付与负责范围 |
| --- | --- |
| 网站后端／本对话 | 完整发布的回执、新 run 的私有规划快照、当前资格衔接、媒体路由及原图回退诊断、实际站点接入 |
| 小图处理对话 | 当前来源投影与资格 inventory、原件／合格小图缓存、按需编码、预算与私有登记、覆盖清单 |
| Claude | 页面、图片位置与档位、占位和加载反馈、筛选与交互、少量真实页面视觉验收 |

本项编辑范围为 `scripts/website-sync/run.ts`、`publication-handoff.ts`、对应测试与说明。缩略图的 `scripts/media-thumbnails/`、Claude 组件、共享 contracts 与冻结 SQL 均沿用既有实现，接续开发先核对各自进度登记。

## 发布交付文件

固定 v2 入口在 `publish` promote 成功、独立 reader 核验同一 run 和 schema 后，尝试导出：

```text
WEBSITE_OUTPUT_DIR/
  receipt-private.json
  thumbnail-handoff/
    snapshot-private.json
    handoff-private.json
```

目录为 700、文件为 600。快照沿用 `{version, records}`，`version` 为服务器返回的 `runId:revision`，可以直接交给 `scripts/media-thumbnails/plan-cli.ts --snapshot`。快照包含小图选择器涉及的动态、相册、作品、博客、项目与课程类型；只有当前服务器政策允许的记录进入结果，不因此启用新的栏目。读取包含正文，保证相册图与动态图可供现有选择器规划；学习笔记与关于正文不在此交付中。

导出额外执行一次有界 reader SQL 请求，使用网站 repository 的当前资格过滤和撤回引用清理；不读 Notion、不读图片、不上传。它不使用 worker 暂存正文代替当前公开投影。服务器原有 20,000 条／16 MiB 响应边界保留，导出文件上限 32 MiB；超限明确记为交付不可用，不拆出不完整的“全量”交接。

manifest 写在最后，记录 run、schema、release、来源配置摘要、reader 观察时间，以及快照的版本、SHA-256、字节数和记录数。只出现快照而没有 manifest 表示交付未完成；已有交付目录不覆盖。`validUntil` 明确为 null，`qualification=RECHECK_CURRENT_RUN_AND_SOURCES_BEFORE_EXECUTION`：它是规划输入，不能作为仍获准上传、登记或站点读取的证明。

回执和主机 `latest-run-private.json`／`last-success-private.json` 增加 `thumbnailHandoffStatus` 与就绪文件引用。`ready` 仍须配合 `published=true`、`readerVerified=true`、同一 run 的成功回执及 manifest／文件 SHA 核对；它不代表小图已登记或站点已启用。`unavailable` 有单独错误码，不撤销已验证的发布，不自动重新完整采集；修复交付问题后重新从当前 reader 导出到新的私有输出目录即可。取消／运行预算仍由原入口处理，不能把取消回执当成功交付。

## 小图对话接续顺序

1. 核对成功回执、manifest 和快照 SHA；快照版本与 inventory 的 `snapshotVersion` 必须完全一致。只使用私有文件，不复制真实标题、来源、签名地址或正文到仓库文档。
2. 新鲜读取服务器当前 run、revision、epoch、policy／schema、有效期与空闲租约，并读取候选所需的 400／800 两档来源投影，按已有 `ThumbnailPlanningInventory` 形状交付 inventory。服务器不再是该 run、资格过期或修订变化时停止；必要时重新导出当前快照，不延长旧资格。
3. 沿用现有离线规划器和页面档位选择，汇总已有映射、可复用对象、需新增的小图与失败项。直接外链保留既有处理，不为发现 asset ID 抓取外链。
4. 优先匹配已有 verified cache 的来源 SHA、指纹、尺寸与编码 recipe。新批次仍须当前来源与实际对象核验后登记，不能继承旧批次资格；命中不意味着重新上传。零原件／零上传路径沿用已有严格预算，未命中就停止该路径，不用重新下载绕过预算。
5. 新编码与批量上传由图片对话按其获准范围执行；本交接不授予新额度。交回当前 run、已登记父图与档位数量、字节汇总、失败／缺口及代表资产。已完成的生成／画质证据沿用，只复验变化或未解决的项目。

## 实际站点接入与 Claude 验收

网站后端先确认目标部署使用匹配的 v2 reader／Notion 媒体来源以及 `MEDIA_THUMBNAILS=enabled`，再检查一张列表图 400 档、需要时一张大封面 800 档、一个缺映射但获准的原图回退和原图入口。预览应为 200／WebP；原图沿用普通图跳转或转换图读取，灯箱入口不改。资格过期、权限错误或来源改变不得冒充正常回退。沿用 private／no-store，缓存期限另作产品决定。

配置值与部署代码必须实际核对，不能根据源码默认值声称站点开关已开。若现有部署已有匹配代码／配置，内容与登记更新无需另建部署；环境变量变更需要新部署时，按具体发布安排执行，不在工程测试中自动触发。

Claude 接收目标站点、当前有效窗口、代表页面、档位／覆盖缺口与后端读取结果，只复验实际页面的排版、加载反馈、灯箱和交互。小图覆盖就绪后再处理已明确暂停的自动加载发布，不重做已交付的年份 API 或 UI。扩大课程公开名单、目录日期／类型排序和缓存期限都不包含在本交接中。

## 验证范围

工程验证只覆盖导出与既有规划器兼容、当前撤回清理、错批次／失效读取拒绝、私有权限、取消及不覆盖，以及仓库要求的 check／build。真实完整同步是发布动作，完整 dry-run 也会重读 Notion 和全部图片；二者都不是本项测试步骤。实际资格失效时记录该阻塞，等待获准的新内容发布，不反复请求全部媒体。
