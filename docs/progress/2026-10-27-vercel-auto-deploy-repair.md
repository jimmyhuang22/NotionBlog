# 2026-10-27：Vercel main 自动部署接线修复（Codex）

编辑登记：用户要求排查 F47 合并 main 后未创建自动部署的问题并修复。本项在最新 develop 的独立分支记录；云端操作仅针对原生产项目与同一 Git 仓库，不修改网站代码、来源、凭据值或业务调度。

## 排查与处理

- F47 的 main 提交 `40a50ef` 没有自动部署记录，后来按发布授权手动创建的同提交部署已就绪。更早 `25e3e69` 的部署元数据和项目活动明确标为 Git 触发，证明该项目曾正常接收 Git 部署。
- 仓库 `git.deploymentEnabled` 允许 main，通配禁用不覆盖显式启用；[Vercel 规则说明](https://vercel.com/docs/project-configuration/git-configuration)规定匹配多条规则时任一为真即部署。项目完整 API 回读也确认创建部署开关已开启、生产分支为 main、仓库 ID 正确、没有忽略构建命令；两次合并的作者、邮箱和签名状态一致。
- GitHub 上的 Vercel App 未暂停且覆盖该仓库。待更新权限只有 Actions 读取和 Workflows 读写；[官方说明](https://vercel.com/changelog/vercel-github-app-updated-permissions)明确用于 Agent／v0 的工作流功能。未批准这些新增权限，也没有将它当成自动部署缺失的原因。GitHub 要求的重新验证由用户在浏览器完成，未向聊天提供密码。
- 初次同仓库 connect 只是“已经连接”的空操作。随后按本次修复授权断开并立即重连原项目的同一 Git 连接，回读确认仓库、Git 凭据句柄、main 分支、构建／安装命令、Node 版本、域名自动分配及其他选定部署设置均未改变，连接更新时间已刷新。线上既有部署继续服务。
- 没有取得 Vercel 内部 webhook 投递日志，不能仅凭配置正常就断言具体是 GitHub 投递失败或 Vercel 丢弃任务；实际自动触发验证另见下节。

## 零改动自动触发验证

用户明确同意本次例外：从当前已上线 main 准备零文件差异的验证分支，main PR 平台检查通过后由 Codex 普通合并，最多新增一次同代码生产部署，不包含 develop 尚未发布的改动。

[验证 PR #182](https://github.com/jimmyhuang22/NotionBlog/pull/182) 的空提交 `a6c10e1` 以 `40a50ef` 为父提交，完整文件树均为 `882db9a`，实际差异为零文件。同树本机完整 Node 24 check 的 3,079 项及 build／49 份追踪已通过，不重复同代码全套；验证 PR 自身仍须完成平台检查。

项目原来开启无变化项目跳过优化；空提交可能合法跳过，不能据此判断事件接收失败。本次验证期间暂时将 `enableAffectedProjectsDeployments` 设为 false，并确认这是唯一改变的选定项目字段、原生产指针保持；验证结束恢复原 true 值。该控制不修改源码、构建命令或权限。[平台 check／build](https://github.com/jimmyhuang22/NotionBlog/actions/runs/40434338570)及[隐私历史检查](https://github.com/jimmyhuang22/NotionBlog/actions/runs/40434338210)均成功；check 和 build 实际执行通过，Ubuntu 3,079 项中 3,078 通过、零失败／取消、1 项 Mac 专用断言按平台条件跳过，已由同树本机完整检查和定向 Node 24 验证覆盖，符合现有[检查说明](../GITHUB_ACTIONS_RUNNER.md)；49 份构建追踪通过。

已按本次授权普通合入 main，提交 `724ebac`；实际完整文件树仍为 `882db9a`，零代码变化。合并后平台立即创建对应 production 部署，来源明确为 `source=git`，已 READY，构建约 60 秒，正式域名及生产指针已切到该部署，域名分配无错误，GitHub 的 Vercel 状态回报为 success；本次没有调用手动部署作为验收，按提交查询仅有这一份 production 部署。

部署就绪后已把无变化跳过优化恢复为原 true，回读全部选定设置与重连后的原状态一致，仅连接更新时间是此次重建结果。确认内容同步空闲且共享锁不存在后，公开首页一次读取返回 HTTP 200，正文 96,978 字节（约 95 KB，缓存 MISS），两条 F47 在玩文案仍可见，没有下载媒体；该字节数只计 HTTP 正文，不是数据库到应用或账单流量。限定本次部署的近 10 分钟 error／fatal 日志查询未发现记录。

本次已实测恢复 main 的 Git 自动触发通道；平台内部历史事件丢失的精确环节仍无日志证据，不将“重连后成功”扩大为对内部根因的证明。

## 边界与下一项

排查读取公开文档、Git／部署控制面和 GitHub App 设置，没有读取真实内容正文或下载媒体。没有新装 CLI、恢复私人运行器、批准新增 App 权限或修改环境变量。精确事件丢失环节与自动触发恢复结果分别记录，不把重连成功或手动部署当作自动部署验收。

结果记录通过独立 develop PR 合入，并同步此次已发布 main 的合并祖先。收尾只改本文件，按记录格式、相关链接、隐私及实际差异检查验证，不为说明新增生产部署。
