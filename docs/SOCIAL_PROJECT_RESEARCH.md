# 社交采集项目选型调研

核对日期：2026-10-12。用户要求先调查 GitHub 类似项目，再决定直接使用、参考代码或自建。以下是公开仓库、固定提交源码及许可证评估；没有安装、构建或使用本人账号运行这些第三方程序。已有本人账号样本测试是独立证据，见 [账号测试结果](SOCIAL_ACCOUNT_PROBE.md)。

## 建议

采用自建同步核心、按平台选用或参考读取模块的结构。作品关联、统计语义、SQLite 待上传队列、Supabase 展示投影及现有网站入口由本项目维护；上游项目只负责读取输入，输出须重新验证身份、字段和完整性。

首版 B 站继续以已经实测的指定公开视频页面读取为基线，轻量 CLI 可作为对照候选。小红书优先研究 `xiaohongshu-mcp` 的浏览器只读部分，以及两个 CLI 的字段／错误分类设计。完整框架仍有参考价值，不能把功能范围大等同于必须启动全部数据库或 WebUI。

这是实施候选建议，没有选定新依赖、冻结接口或授予新的运行／发布权限。

## 候选对比

以下最新提交日期由 GitHub API 当日读取，部分最新提交仅更新文档，不能据此认定平台接口仍可用或维护承诺稳定。

| 项目 | 已核对的能力与运行方式 | 最新提交（UTC）／许可证 | 对本项目的判断 |
| --- | --- | --- | --- |
| [MediaCrawler](https://github.com/NanmiCoder/MediaCrawler) | Python／Playwright，多平台，指定作品与创作者、SQLite 等输出；可直接 CLI 运行，WebUI 可选 | 2026-10-10；非商业学习许可证 1.1 | 适合学习平台分层、错误处理与字段；不作为长期博客基础直接复制。授权明确限于学习／研究，不能把个人博客自动视为满足范围 |
| [xiaohongshu-mcp](https://github.com/xpzouying/xiaohongshu-mcp) | Go／Rod 浏览器，登录、主页、详情与互动数据；同时包含发布及评论操作 | 2026-10-09；Apache-2.0 | 优先研究只读浏览器模块，按需提取或封装；整套 MCP／HTTP 服务不是首版必要项 |
| [XHS-Downloader](https://github.com/JoeanAmier/XHS-Downloader) | Python 小红书作品信息、媒体下载与作品 ID 记录；CLI／GUI／API 等入口 | 2026-09-16；GPL-3.0 | 下载与去重设计可参考；本阶段只需要元数据和统计，不以下载器替代同步系统，直接复制或分发的许可另核对 |
| [xiaohongshu-cli](https://github.com/tamnd/xiaohongshu-cli) | Go 单个命令行程序、JSON／JSONL、页面初始状态与可选登录 API 路径 | 2026-08-19；Apache-2.0 | 运行形态贴合周期任务；维护历史较短，计数缺失及字段映射须修正／验证后才能采用 |
| [bilibili-cli](https://github.com/tamnd/bilibili-cli) | Go 命令行，视频与创作者读取、结构化结果和错误分类；第三方网页接口客户端 | 2026-08-19；Apache-2.0 | 适合做字段与失败分类对照，尚未本人账号实测；不能把第三方网页接口称为官方开放 API |
| [Douyin_TikTok_Download_API](https://github.com/Evil0ctal/Douyin_TikTok_Download_API) | 当前 v5 包含 API、worker、数据库、Redis、控制台及可选浏览器／下载组件 | 2026-10-02；Apache-2.0 | 未来抖音接入再评估；当前系统已有云端存储和任务体系，完整部署会增加运维范围 |

许可原文：[MediaCrawler LICENSE](https://github.com/NanmiCoder/MediaCrawler/blob/main/LICENSE)、[小红书 MCP LICENSE](https://github.com/xpzouying/xiaohongshu-mcp/blob/main/LICENSE)、[XHS-Downloader LICENSE](https://github.com/JoeanAmier/XHS-Downloader/blob/master/LICENSE)、[小红书 CLI LICENSE](https://github.com/tamnd/xiaohongshu-cli/blob/main/LICENSE)、[B 站 CLI LICENSE](https://github.com/tamnd/bilibili-cli/blob/main/LICENSE)、[抖音项目 LICENSE](https://github.com/Evil0ctal/Douyin_TikTok_Download_API/blob/main/LICENSE)。选择具体代码时核对该文件及依赖许可、版权声明和 NOTICE，记录固定提交与改动；此表不作跨项目许可兼容结论。

## 两个旧 B 站项目的状态变化

- [Nemo2011/bilibili-api](https://github.com/Nemo2011/bilibili-api) 已于 2026-07-06 归档，当前只保留停止维护的声明；不再推荐为新增长期依赖。
- [SocialSisterYi/bilibili-API-collect](https://github.com/SocialSisterYi/bilibili-API-collect) 当前也已归档，默认分支为 `deprecated`，README 说明停止维护并删除相关资料。旧教程与历史推荐不能作为今天的可用性证明。

这使 B 站采用独立、窄范围读取模块更有必要，但自己写代码也不会自动消除平台改版、权限或网络失败；正式可用性仍需实测。

## 源码核对发现

1. **小红书 MCP 与已验证方式接近。** [主页读取](https://github.com/xpzouying/xiaohongshu-mcp/blob/7797fd375aba02dcd33afe143f6bee13e5870859/xiaohongshu/user_profile.go)通过页面 `__INITIAL_STATE__` 获取资料和当前 tab 的笔记；这个函数没有完整历史滚动循环，不能单独作为全量历史证明。[字段结构](https://github.com/xpzouying/xiaohongshu-mcp/blob/7797fd375aba02dcd33afe143f6bee13e5870859/xiaohongshu/types.go)包含点赞、收藏、评论和分享字符串，以及图文／视频区别。接入时仅投影作品和计数，避免把详情结果中的评论列表保存下来。
2. **轻量 CLI 也需要定制。** [小红书 CLI 的转换函数](https://github.com/tamnd/xiaohongshu-cli/blob/b60f9a384ed32d002aaacbbff95fedb2bdc96682/xiaohongshu/note.go)对部分 API 计数使用 `atoi`，空值及解析失败返回零；数值结构也没有保留未知状态。本项目要求未知为 null、真实零为零，因此不能直接信任最终整数字段。页面近似显示值仍要保留原文和精度。
3. **分享字段名称不同。** 小红书 MCP 类型绑定 `sharedCount`，CLI 页面类型绑定 `shareCount`。需要用同一真实页面核对实际版本和分支，不能因字段名称存在就认为分享数据已完整。
4. **身份与分页必须独立检查。** CLI 的部分详情转换会在目标 map 键缺失时选另一个条目；我们仍须验证返回作品 ID、作者和配置一致。主页首屏、指定作品成功和完整作者历史分别验收，列表暂缺不当作删除。
5. **框架功能可关闭，但依赖仍有成本。** MediaCrawler 支持 CLI＋SQLite，不强制安装独立 MySQL 服务或 WebUI；它的 [依赖清单](https://github.com/NanmiCoder/MediaCrawler/blob/main/pyproject.toml)仍包含浏览器、多个存储驱动、图像和数据处理模块。当前抖音 v5 则是明确的多组件系统，部署复杂度需单独计算。

## 复用边界与定制内容

| 可考虑复用／参考 | 本项目应维护的内容 |
| --- | --- |
| 页面字段定位、作品 ID／链接解析、本人登录流程、错误分类、分页设计 | 跨平台作品人工关联、一张作品卡片与独立平台指标 |
| 有界只读入口与最小字段输出 | 本地采样、队列确认、重复上传、旧采样拒绝、恢复与运行状态 |
| 图文／视频识别与实际发布时间 | 未知值、近似计数、真实零、合集／单稿件、公开资格与统计新鲜度 |
| 经验证的格式转换和测试用例设计 | 私有来源配置、受限云 writer／reader、网站统一入口、后续调度 |

首版优先保持 TypeScript 同步核心。读取模块可以是独立短时进程，经 JSON／JSONL 接入，不必把 Python／Go 代码翻译进 Next.js，也不必为了 CLI 新开常驻 HTTP 服务。是否引入 Go 程序／Python 环境等新运行依赖，在候选实测后决定。

## 下一步对照验证

1. 用已有指定 B 站样本和小红书图文链接比较候选读取结果：作品／作者身份、原发布时间、类型及四类互动数；原始值、null 与近似精度分开检查。
2. 区分首屏与完整分页；小红书另找获准视频样本验证，登录失败／验证／限流返回明确状态。已有项目的匿名可读宣传不能覆盖本机匿名转登录的实际结果。
3. 核对缓存和实际采集时间，禁止给缓存数据伪造新的观测时间；仅提取计数，不采集评论原文或启动发布功能。
4. 通过相同输出契约比较运行负担、修改量与失败恢复。通过后固定上游提交、保存许可和来源记录，再决定直接包装、提取小模块或保留自写适配器。

本次不把第三方项目写入依赖、不复制其实现进生产代码、不访问本人账号、不改云端存储或调度。正式的端到端实现仍按 [系统架构](SYSTEM_ARCHITECTURE.md)推进。
