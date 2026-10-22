# 2026-10-13：Mac mini 承担仓库 Actions 检查

用户授权安装本仓库的官方原生 runner，并选择系统启动后无需 GUI 登录接单。使用专用普通账户和单个 repository-level runner；程序及注册身份放内盘，任务检出与可重建缓存放独立外置 SSD 目录。GitHub 分发任务，launchd 保活，不引入容器或第二个调度器。

为减少 GitHub-hosted 分钟消耗，原 Node 24 检查与构建拟通过 PR 改为 `self-hosted/macOS/ARM64/notionblog` 标签组合。先由该 PR 实际运行并测量资源，主线切换等待审核与无登录重启验收。保留原验证内容、只读 token、超时和取消规则；普通 fork PR 不派发到原生主机，执行范围仍限可信私库代码。

此决策仅补充 CI 执行位置，不改变分支、合并、公开、生产部署、数据同步与来源权限政策。macOS 构建不代替 Vercel Linux 部署验证；详细边界见 [运行说明](../GITHUB_ACTIONS_RUNNER.md)。
