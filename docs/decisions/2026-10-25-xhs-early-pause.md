# 2026-10-25：小红书早期失败使用独立持久暂停

用户明确批准 [N05 完整方案](../BACKEND_XHS_EARLY_PAUSE_PLAN.md)的源码、局部离线回归及常规 develop 交付，包含正常 PR／push 自动 CI。

沿用既有 HTTP health 的 manualRequired 与浏览器 state 的 paused 两个独立闩，不改版本／字段、原生消息或人工恢复入口。已验证运行上下文、取得原锁后发生的早期非 BUSY 失败，分别尝试两个持久写入；只有已验证 scope 才记录其摘要，否则采用既有全零未知占位，不将占位解释成范围或执行授权。HTTP 闩不升级为所有浏览器入口的共享禁令。

异常与 finally 不再为了暂停读取可能已损坏的主配置／scope。重新读取最新 browser state／recovery，保留 accepted、既有暂停和最新证据；显式重传的外层 catch 同样不能回写旧快照。写盘／关闭失败保留原业务异常并继续清理；诊断只提供固定受控代码。文件系统或状态本身损坏时不承诺全部持久写入成功。

本决定补充[浏览器单篇恢复](2026-10-14-xiaohongshu-browser-recovery.md)及[HTTP 暂停](2026-10-14-xiaohongshu-http-refresh.md)，不改变持续任务许可、BUSY 延期或显式恢复。没有真实浏览器、配置／凭据、项目请求、实际暂停目录修改、运行包安装、任务恢复、main 发布、部署或手动 CI 授权。整组源码稳定后集中一次完整 check／build，开发期只验证直接相关行为。
