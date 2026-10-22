# 文档导航

先用根目录 [README](../README.md) 运行离线演示，再按需要接入真实来源。本文按使用场景组织入口；各文档中的历史验收应结合日期阅读。

## 开发与内容接入

| 目标 | 文档 |
| --- | --- |
| 了解范围与协作方式 | [项目需求](REQUIREMENTS.md)、[开发约定](../AGENTS.md) |
| 本机开发、离线构建、有限真实联调 | [开发隔离](DEVELOPMENT_ISOLATION.md) |
| 配置 Notion 来源与字段 | [Notion 接入](NOTION_SETUP.md)、[内容能力](WEBSITE_CAPABILITIES.md) |
| 接入 PostgreSQL reader | [数据库接入](WEBSITE_DATABASE_SETUP.md)、[有界内容读取](SCOPED_CONTENT_READS.md) |
| 学习层级与来源公开规则 | [学习公开与排序](STUDY_PUBLICATION.md) |
| 页面、主题与正文渲染 | [前端开发指南](FRONTEND_GUIDE.md) |
| 隐私、提交检查和准备公开 | [隐私约定](PRIVACY.md)、[公开准备报告](PUBLIC_READINESS.md) |

## 独立任务与媒体

| 目标 | 文档 |
| --- | --- |
| Notion 内容采集与运行 | [同步 worker](NOTION_SYNC_WORKER.md)、[网站同步运行器](WEBSITE_SYNC_RUNTIME.md) |
| 数据库发布协议与恢复 | [同步协议](DATABASE_SYNC_PROTOCOL.md)、[网站数据库恢复](WEBSITE_DATABASE_RECOVERY.md) |
| 持久与增量发布 | [持久发布](CONTENT_PUBLICATION.md)、[增量发布](INCREMENTAL_PUBLICATION.md) |
| 图片来源、缩略图与存储 | [混合媒体](HYBRID_MEDIA.md)、[图片预览副本](MEDIA_THUMBNAILS.md)、[存储转移](THUMBNAIL_STORAGE_TRANSFER.md) |
| 游戏平台账户同步 | [账户同步](GAME_ACCOUNT_SYNC.md)、[作品库字段](MEDIA_LIBRARY_SCHEMA.md) |
| 社交作品、合集与封面 | [社交采集](SOCIAL_SYNC.md)、[合集云端](SOCIAL_COLLECTIONS_CLOUD.md)、[社交读取](SOCIAL_READER.md) |
| 首页与动态接口 | [首页混排](HOME_FEED.md)、[动态接口](STATUS_API.md) |
| 公开页面缓存 | [缓存机制与接入](PUBLIC_CONTENT_CACHE.md) |

## 部署与交接

- [部署试验](VERCEL_SUPABASE_TRIAL.md)：托管平台、数据库和同步链路的准备顺序。
- [重构交接](REFACTOR_ROLLOUT.md)：阶段能力、运行切换、验收与回退边界。
- [开发环境交接](DEVELOPMENT_HANDOFF.md)：依赖、私有输入及接手步骤。
- [Actions 运行器](GITHUB_ACTIONS_RUNNER.md)：现有私人仓库的检查环境；公开前须另行处理运行器隔离。
- [决策](decisions/README.md)与[进度](progress/README.md)：每项工作独立记录，按日期查看；旧的单文件记录仅为存档。

安装迁移、运行采集器、启动调度、切换生产 provider 和公开仓库是不同操作。配置示例及一次本机测试通过，不代表已经完成真实上线。
