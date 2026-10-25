# 2026-10-25：控制台开机自动运行（Claude）

## 编辑登记

修改 `console/run.mjs`、`console/README.md`（#138）、`scripts/console-bridge/cli.ts` 与测试（#139）、`scripts/console-bridge/content.ts`、`console/lib/bridge-backend.ts`、[对接协议](../CONSOLE_BRIDGE.md)，新增本记录。没有修改网站、同步程序、Dagu 定义或数据库。

用户选择让控制台开机自动运行。本机安装（不在仓库内）：

- 代码在 `~/Services/notionblog-console/releases/<提交>/`，`current` 指向正在用的版本；依赖按锁文件安装，锁文件不变时从上一版克隆。
- 私有配置、env 与桥接状态在 `~/Services/notionblog-console/.local/`（700，文件 600），从工作区移出，桥接命令经 `current` 调用。
- LaunchAgent `local.homelab.notionblog-console`：固定的 Node 24、开机启动、退出后自动拉起，日志在 `~/Library/Logs/HomeLab/notionblog-console/`。命名与目录沿用本机其他 HomeLab 服务。

## 修了什么

- **launchd 下找不到 node。** 启动脚本原来调用 `node_modules/.bin/next`，它依赖 PATH 里的 node；launchd 没有。改为用当前 Node 直接运行 Next 的脚本。
- **经 `current` 符号链接调用时桥接命令无输出。** 入口判断比较的是未解析的路径，改为比较真实路径，并加了经符号链接运行的测试。
- **内容页冷启动太慢。** 缓存为空时，栏目统计会拉取全部列表和 13 棵课程树，内容页又同时发出两个请求，超过 15 秒读取时限，结果页面为空。现在栏目数量只取各列表的 `total`，缓存延长到 10 分钟，内容类请求使用 60 秒时限。

## 外接硬盘的访问权限（待用户授权）

装成服务后，页面每次等满 15 秒才返回。排查结果：由 launchd 直接启动的 node 可以查看外接硬盘上的文件是否存在，但读取文件内容会被 macOS 隐私保护挂起，直到获得授权；同步状态文件就在外接硬盘上。在终端里启动没有这个问题，Dagu 下的任务也没有，因为它们沿用的是已获授权的程序。桥接进程超时后会被结束，不会越积越多。解决办法是在 Mac mini 上为这个 node 授予访问外接硬盘的权限，需要用户本人操作。

同时把 LaunchAgent 的 `ProcessType` 从 Background 改为 Standard，免得 CPU 和磁盘被限速。另修正：桥接超时时页面显示“内部错误”而不是“后端没有响应”，原因是 Next 把代码拆到不同块里后 `instanceof` 判断失效，现在按错误字段判断（`isBackendError`）。

## 验证

- `env -i`（PATH 只有 /usr/bin:/bin）加固定 Node 24 启动控制台，返回 200。
- 服务方式：LaunchAgent 运行中；结束进程后约 10 秒自动拉起，登录页 200；局域网地址登录后，总览、其他任务、记录正常。
- `tests/console-bridge.test.ts` 14 项通过；类型检查与隐私检查通过。

## 限制与下一项

- 监听的是 Mac mini 当前的局域网地址；地址变了要改私有 env，建议在路由器里固定。
- 更新控制台需要按 README 新建 release、构建、切换 `current` 再重启，暂时没有一键脚本。
- 真实下架验收仍等 Codex 处理第 45 轮租约。
