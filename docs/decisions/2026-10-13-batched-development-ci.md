# 2026-10-13：日常开发本机验证后合并，CI 集中运行
状态：已被 [2026-10-22-develop-merge-local-verification](2026-10-22-develop-merge-local-verification.md) 取代。

用户在自托管 CI 排队阻止后端继续合并时提出：“不过CI，直接合并，然后继续开发”，并建议约一两小时做一次。本轮按该行动请求调整 develop，默认间隔取两小时；不将此请求扩大为跳过生产发布验收。

日常 develop PR 保留按影响的本机验证、冲突核对、受检提交与实际差异记录，完成后直接普通合并。平台尚未启动、排队或运行器故障不阻止已验证的日常改动；已知真实代码、协议或构建失败不能忽略。本机结果不得写成平台通过，旧失败／中断证据不删除。

不再对 develop 的每个 PR／push 运行完整 CI。开发活跃期间约每两小时集中验证 develop，支持必要时手动提前触发；所有会话先核对实际受检 SHA 与已有运行，避免同一批重复排队。main PR／push 的完整平台检查保留，发布前必须验证当前最终版本；正式发布仍按原用户授权流程。

工作流保留受限 token、可信私库分支条件、自托管标签、固定 actions、Node24、双锁文件、完整 check／build、并发二及十五分钟超时。无新主机服务、运行器修复、权限或内容同步。定时／手动批次的 checkout 和摘要明确记录实际被检查的分支与提交，不能把触发事件的默认分支 SHA 当成 develop 检查证明。

自动周期使用每两小时一次、避开整点的 GitHub schedule。GitHub 只从默认分支运行定时流程，因此配置先进入 develop，随之后获准的 main 发布才自动生效；之前按手动集中方式推进，不改仓库默认分支或为启用定时任务单独发布网站。参考 [GitHub 事件说明](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)。

本项取代 [按影响验证决策](2026-10-13-merge-validation-by-impact.md) 中日常合并必须等待平台检查的部分，保留其按影响验证原则；补充 [develop 自行合并](2026-10-13-develop-merges-without-asking.md)。共享范围、公开资格、凭据和 main 发布授权的其他约定保持。
