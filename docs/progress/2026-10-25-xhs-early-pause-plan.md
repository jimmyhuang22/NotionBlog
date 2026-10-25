# 2026-10-25：小红书早期失败暂停的离线复现与方案（Codex）

编辑登记：从最新 develop `b13957556500f931fdeceda4bf61b7a4de1175b0` 新建独立短支，仅新增本记录与[完整方案](../BACKEND_XHS_EARLY_PAUSE_PLAN.md)。读取原暂停／补采决策、B16 错误边界及当前调用链；共享根草稿和其他工作线的运行副本未修改。

真实 browser notes 入口配临时虚构目录，发现坏 JSON／HTTP policy 坏 JSON × 有／无旧 health 共四组，均异常且正确释放锁，但无新 HTTP 暂停，browser state 仍 complete。主配置随后损坏时，扩展补发 notes-pause 也失败。另验证已有全零 scope 占位可由真实周期解析并保持 manualRequired，prepare／execute 均零；没有 cloud prepare、来源或项目请求。未访问真实浏览器、配置和运行状态。

方案恢复 HTTP 与浏览器各自持久暂停，保留既有状态结构、首错、BUSY、accepted recovery 和锁清理，并覆盖相邻 HTTP CLI 的 catch 重读配置缺口。它不把两条 lane 合成全局闩，不引入新恢复命令或自动恢复。文件系统本身不可写时的限制明确保留。

本轮只做一个离线复现程序及记录／链接／隐私核对，不运行全套 check／build。当前未改应用源码、依赖、DTO、fixtures 或状态协议，未 commit／push／PR。下一步是按 AGENTS.md 对共享暂停与原生入口范围取得本方案的明确确认；批准后集中实施，再按影响完成一次收尾验证与常规 develop 交付。

后续：用户已明确批准完整方案；源码与验证接续见[实施记录](2026-10-25-xhs-early-pause.md)，本记录仍只描述批准前的基线复现。
