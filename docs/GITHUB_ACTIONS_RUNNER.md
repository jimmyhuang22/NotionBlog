# GitHub Actions 检查

本仓库使用 GitHub 托管的 `ubuntu-latest` 运行器和 Node 24，检查发往 `main`、`develop` 的合并请求；维护者也可手动选择分支运行。初始代码导入不自动启动定时或 push 检查。

工作流安装根目录与 `scripts/game-sync/` 两份锁文件的依赖，再执行 `npm run check` 和 `npm run build`。检查环境使用离线 fixtures、隔离 PGlite 和本地媒体；不配置 Notion、数据库、媒体、个人机器或生产部署凭据。Token 仅有 contents 读取权限，checkout 不保留凭据。

旧私人仓库的自托管运行器、两小时调度和历史通过回执不迁入此仓库。旧记录保留在私人归档，不能当作新提交的平台验证。`scripts/ci/check-plan.ts` 仍保留其已有实现及测试，但新工作流不使用该本机回执缓存。

正式发布仍按 [AGENTS.md](../AGENTS.md) 走开发集成与发布请求；平台检查通过不自动授权公开仓库、部署或恢复业务同步。运行器配置变动需验证实际平台结果，不能只据本机检查宣布托管环境通过。
