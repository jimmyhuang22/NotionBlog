# 2026-10-13：增量运行程序的受限数据库绑定（Codex）

## 编辑登记

从最新 develop `b0435d5` 开 `codex/incremental-database-binding`。新增后台读写连接绑定、只读 verify 命令、关联测试及本项说明。公共179的队列／发现、学习 checkpoint／domain 和图片准备分别由原支线维护，本项不编辑其工作树，不改共享契约、旧 SQL／存档、来源、线上 release 或 Dagu。

## 变更

实际 pg 小池连接 reader 和 writer。核对当前 LOGIN 与其单一 NOLOGIN 权限组、私有数据／所有权／函数授权、同端点与池租户、已接受发布的 scope／schema／epoch／版本；取消、错配或权限失败安全关闭。复用原 publisher、单页 reader 与独立确认，不重做 SQL 或自动重试。

新增 `SYNC_READER_DATABASE_URL` 为显式后台输入，不自动复用另一端点的网站 URL；verify CLI 仅读本机配置和权限／版本元数据，输出汇总，不访问 Notion／对象或改变云状态。

## 验证

18 项实际 PGlite 权限／发布关联测试通过。最终 Node 24 `npm run check` 通过：1364 项测试、类型、全部协议和 588 文件隐私检查。本机同时进行多份套件时，首次检查有一项旧 CLI 进程期限测试超过外层五秒；其余 1363 项通过。该项单独复核在 1.66 秒通过，随后使用任务私有 Node 包装限制测试文件并发为二，完整检查全过；没有更改断言、测试超时、package 或 CI 命令。

`npm run build` 通过，40 个服务端 trace 排除私有输入。测试中的 Status 路径最初未按 v2 规范调整，已修正虚构输入；按真实 LOGIN 继承 NOLOGIN 权限组验证，没有修改迁移或真实账号。

## 局限和下一项

PGlite seam 验证 SQL 权限，不冒充实际 TCP／TLS／云验收。没有真实源、媒体、云查询或写入，没有改 provider、迁移或排程。公共发现及学习持久状态仍在各自支线接续，主运行器消费本绑定后集中做指定页变更与恢复；图片独立交付和 Notion 阻断验收完成前不发布 main。
