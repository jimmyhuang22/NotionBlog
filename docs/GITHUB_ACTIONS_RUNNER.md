# GitHub Actions 检查

工作流按仓库的实际可见性选择运行环境，Node 版本固定为 24：

| 仓库状态 | 触发方式 | 运行环境 |
| --- | --- | --- |
| 私人迁移准备 | 仅仓库所有者手动选择已审分支 | 专用 macOS ARM64 自托管运行器，标签 `self-hosted`、`macOS`、`ARM64`、`notionblog` |
| 公开后 | 发往 main／develop 的 PR，或手动选择分支 | 标准 GitHub 托管 `ubuntu-latest` |

私人阶段的 PR 事件跳过此任务；需要验收时，由所有者在 Actions → Repository checks → Run workflow 选择实际候选分支。运行结束核对实际仓库、SHA、运行器及全部步骤，不能把跳过的 PR、排队或本机通过视为 Actions 已通过。初始导入不自动触发 push 或定时检查。

工作流安装根目录与 `scripts/game-sync/` 两份锁文件的依赖，再执行 `npm run check` 和 `npm run build`。检查使用离线 fixtures、隔离 PGlite 和本地媒体；不配置 Notion、数据库、媒体或生产部署凭据。Token 仅有 contents 读取权限，checkout 不保留凭据。私人运行器保留专用非管理员账户、受管服务、磁盘与任务前守卫，不使用开发检出，不迁入个人环境。

## 复用既有运行器

既有运行器是仓库级注册，只能接收其绑定仓库的任务。新仓库即使最终与旧库同名，仓库 ID 也不同，修改 YAML 标签不会自动搬迁注册。

接线前保存当前注册及受管服务配置，核对运行器 idle 并防止新旧任务同时争用。注册、移除与服务配置通过官方短期注册方式和既有运维管理入口处理；不提取 Git 凭据，不改磁盘权限、系统隐私权限、账户权限或守卫。单个运行器只承接一个任务，失败保留记录。源码、旧工作区和业务同步不随 CI 重新绑定移动或恢复。

旧库的两小时调度、树缓存和历史通过回执不复制到新库。`scripts/ci/check-plan.ts` 保留原实现和测试，新工作流暂不使用其历史缓存，首次实际验收执行完整检查与构建。CI 接线候选与实际注册／成功验收分别记录。

## 公开前的交接

公开之前先停止并移除此仓库的原生自托管注册，核对无在途任务和无残留注册；只改 `runs-on` 或依赖 PR 条件不能阻止他人提交修改工作流。保留旧私人运行根及可恢复的受管配置。需要继续私人 CI 时，在保持私人的仓库单独管理，不将外部 PR 分派到个人机器。

随后核对标准托管运行器路径、主分支保护与实际平台检查，并审查私人阶段 CI 日志中可能出现的机器或文件路径信息。工作流通过不自动授权公开仓库、部署或恢复业务同步；正式发布仍按 [AGENTS.md](../AGENTS.md) 执行。

GitHub 当前将自托管运行器和公开仓库标准托管运行器列为免费使用；私人仓库的托管分钟额度与之不同。官方说明：[计费](https://docs.github.com/en/billing/concepts/product-billing/github-actions)、[仓库级运行器范围](https://docs.github.com/en/actions/concepts/runners/self-hosted-runners)、[原生运行器安全边界](https://docs.github.com/en/actions/reference/security/secure-use)。
