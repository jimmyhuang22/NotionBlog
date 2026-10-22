# 正文读库与动态图片

试验采用 `CONTENT_PROVIDER=database`、`MEDIA_PROVIDER=notion`。正文仍来自 Supabase PostgreSQL 快照，普通 JPEG／PNG／WebP／GIF／AVIF 使用兼容的 `/media/a1.…` 路径，服务器读取当前 Notion 图片后返回 302，访客直接从来源取图。Notion 托管图片每次重新获取临时地址，外链图片继续使用其外部来源。HEIC／HEIF 使用本机转换并存入 Supabase Storage 的 JPEG。

`MEDIA_PROVIDER=storage` 默认保留原行为，无效值明确报错。前端 DTO、图片路径、冻结同步 v1 SQL 与摘要保持兼容。

## 同步、权限与费用

独立私有 `nb_media`（v2 为 `nb_v2_media`）扩展按 `(run_id, asset_id)` 保存定位、owner、SHA、来源指纹和交付方式，不保存临时 URL。登记必须使用当前核心租约并匹配该批次的媒体描述；登记失败阻止整批发布。reader 仅能调用读取函数，writer 仅能调用登记函数；表开启 RLS，PUBLIC 与 Supabase 默认应用角色无权访问。读取同时核对当前发布批次、TTL、公开规则和媒体 owner。

Status 及 v2 已允许整来源栏目的图片资格只读取指定页面及匹配来源 schema，不为单张图查询整个来源；学习页仍逐项检查名单与祖先。每次请求仍需 Notion API 和数据库检查，没有跨请求资格缓存，实际加载速度待目标网络测试。

图片请求先检查数据库资格，再检查当前 Notion owner、图片块及祖先、封面映射、归档、URL 有效期；返回前重新检查数据库。转换图在慢速 Storage 读取后还要重新检查 Notion 来源。权限、定位、来源或索引失败均拒绝请求，不静默回退旧图。托管地址的签名参数刷新不改变指纹，文件路径改变则等待下一次同步；外部相同 URL 的内容变化无法靠 URL 指纹识别。

worker 私有环境设置 `SYNC_MEDIA_PROVIDER=notion` 后，仍从来源下载并验证每张图，以保留 SHA 资产身份，但只向 Storage 上传转换图。普通图片的访问字节不经过 Supabase 或网站代理。报告 `mediaBytes`／`uniqueObjects` 仍指下载验证的去重媒体，不能当成 Storage 上传量。已有云端对象保留，没有压缩重传、删除或自动垃圾回收。

## 启用顺序

合并并安装本版本后，在不与其他同步或数据库维护并发的操作窗口执行：

1. 管理员私有环境运行 `npm run database:admin -- migrate-media`，校验独立迁移摘要与核心版本。管理员连接不能部署到网站。
2. worker 设置 `SYNC_MEDIA_PROVIDER=notion`，保留相同获准来源、政策及 HEIC 转换器。先严格 dry-run／stage 验证，再执行新的完整 publish；旧快照没有定位索引。
3. 网站保留 `CONTENT_PROVIDER=database`，设置 `MEDIA_PROVIDER=notion`；提供只读服务端 `NOTION_TOKEN` 及与同步匹配的 `NOTION_SOURCES_JSON`（本机可用私有配置文件），保留 database／Storage reader 凭据供正文及转换图使用。不能使用 `NEXT_PUBLIC_`。
4. 独立预览验收普通图 302、转换图 200／字节、撤回与映射变化拒绝、正文读库、当前批次及索引覆盖，通过后安排正式环境切换。

代码与离线测试通过不代表云端已切换。云迁移、新完整同步和正式配置须记录实际证据。

新版内容后端已提供同样的混合图片能力，使用独立 `nb_v2_media` 索引及 `/media/v2/a1.…` 路径，保留 v2 未加前缀的媒体身份。v1／v2 索引、租约与发布资格分别校验。v2 先安装既有网站扩展，再运行 `npm run website:sync -- migrate-media` 安装其媒体扩展；随后使用 schemaVersion=2 来源配置、`SYNC_MEDIA_PROVIDER=notion` 运行该版本的严格完整同步，网站保持 `DATABASE_CONTENT_VERSION=2`。不能把 v1 成功批次或索引当成 v2 的验收证据。网站图片来源配置版本不匹配时明确拒绝。

## v1 受保护预览验收

2026-10-11 在固定源码 `3e35ebf` 完成 v1 扩展安装及新的严格完整发布：297 条内容、246 个媒体绑定全量核验；243 个普通绑定使用 Notion 来源交付，3 个 Storage 转换对象共 3,036,824 字节，实际 HTTP 大小、格式与 SHA 全部一致。正文读数据库 v1 与混合图片仅在受保护的分支 Preview 启用，默认环境及 Production 保持 mock；旧 Storage 对象保留未删改。

正常与受限 HTTP、代表页面的 Chrome 图片解码、分页、刷新及六图查看器通过，具体数量与边界见 [进度记录](PROGRESS.md)。这是 v1 的真实预览证据，不代表后续前端、v2、中国内地网络或手机真机已验收。本轮没有启动定时刷新；持续运行仍需保持混合 worker 模式、完整同步来源与索引，并满足原 TTL。

## 切换与恢复

国内网络仍须实测页面、API、Notion 图及转换图的可达性与耗时，不能凭区域推断速度。旧快照的 Storage 对象齐备时可直接改回 `MEDIA_PROVIDER=storage`；混合模式中新出现的普通图没有上传 Storage，因此整体切回前应使用 `SYNC_MEDIA_PROVIDER=storage` 完整同步并核对对象，再切网站。腾讯 COS／CDN 需要新增适配与对象迁移，正文和页面接口可以复用。

原 v1 核心 export／restore 不包含可重建的索引；恢复后保持不可公开，安装扩展并从获准来源执行新的完整带索引同步。已发出的临时地址可能持续有效至到期，站内检查无法即时撤回浏览器已取得的 URL。[Notion 官方说明](https://developers.notion.com/guides/data-apis/retrieving-files)介绍链接有效期与刷新；函数最小授权与搜索路径参见 [Supabase 官方说明](https://supabase.com/docs/guides/database/functions)。

原有 `database:admin export --media` 从 Storage 读取历史描述中的全部对象，混合模式新增普通图不在 Storage，故该命令可能明确失败，不能视为混合模式完整图片备份。核心 JSON 导出仍可用于恢复政策和内容；图片原件保留在 Notion，恢复需重新同步，转换图可重新生成。需要独立、完整离线图片备份时，先补齐原图归档或设计新的混合备份流程；不能把核心 JSON 或仅转换图归档当作全量媒体灾备。

网站 v2 另有 [混合图片归档流程](WEBSITE_DATABASE_RECOVERY.md)：`website:database export --media` 保存核心数据、全部历史定位及经 SHA 验证的普通原图／Storage 转换图，`verify` 完全离线，恢复到匹配空库后仍不可公开。该能力不升级原 v1 工具，也不包含转换前 HEIC/HEIF 原件、服务凭据或托管云恢复。历史原图已经改变或缺失时明确失败，不能声称完成全量媒体备份。
