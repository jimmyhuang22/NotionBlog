# 2026-10-14：社交封面与 Notion 存储身份隔离（Codex）

编辑登记：Codex 负责 server/database 的受限 Storage 与 reader-auth 工厂、server/social/media-storage、独立 Storage 策略模板及专项测试；不改 Claude 页面、契约、fixtures、依赖或已运行配置。

盘点接入方案时发现：仅给旧 Storage 配置加 SOCIAL_MEDIA 前缀没有隔离 Supabase 身份。原工厂要求旧 notionblog_storage_role，而旧桶也按这个声明授权，会使新社交账号得到旧媒体权限。

本项增加固定 notion／social 两种服务端身份。Notion 默认值保留；社交只用服务端 app_metadata.notionblog_social_storage_role，JWT 和 Auth 当前用户必须一致，混合声明、用户可修改声明、旧身份和错误角色全部拒绝。社交 reader 的注入传输同时用于 Auth，可统一取消与计量。专用策略模板建立独立私有桶、摘要键与 SELECT／INSERT，原桶和策略保持，不授权覆盖或删除。参见 [社交封面安装说明](../SOCIAL_WORK_COVERS.md)。

验证：35 项受影响检查通过，包含新身份／当前 Auth 校验／注入传输、原身份兼容、实际两套 RLS SQL 共存、不可覆盖与封面流程。集中一次完整 `npm run check` 的类型、三协议、1,923 项测试及 951 文件隐私扫描全部通过（127 秒）；`npm run build` 通过，43 条服务端 trace 隐私检查通过。首次命令因新工作树漏复制独立游戏 SDK 在类型检查阶段退出，测试未开始；补齐同锁本机依赖后继续，没有为此重复跑一套已完成的测试，也未改项目依赖。只使用虚构输入与本机 loopback，未将离线策略模型写成云端验收。

限制与下一项：这次只有工程，不创建 Auth 身份，不改变 SQL LOGIN／存储权限／云端变量，不下载图片、不安装任务或发布。真实安装仍按有预算的接入方案执行，原件与两档经回读后登记；实际文件大小先在私有准备阶段取得。
