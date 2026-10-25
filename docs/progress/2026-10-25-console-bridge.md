# 2026-10-25：控制台桥接命令第一阶段（Claude）

## 编辑登记

新增 `scripts/console-bridge/`（`cli.ts`、`config.ts`、`errors.ts`、`sync-status.ts`、`takedown.ts`）、`tests/console-bridge.test.ts` 与本记录；修改 `console/lib/types.ts`（`SyncStatus.hold`、错误码 `RUN_FAILED`）、`console/lib/bridge-backend.ts`、`console/lib/demo-backend.ts`、`console/components/sync-panel.tsx`、`console/README.md`、[对接协议](../CONSOLE_BRIDGE.md) 与 [控制台方案](../ADMIN_CONSOLE_PROPOSAL.md) 的分工。没有修改下架工具、同步程序、Dagu 定义、调度、数据库、网站页面或公开范围；没有新增依赖。

用户原先请 Codex 做第一阶段，随后改为由 Claude 完成（“批准，你来完成”）。冻结等第二阶段仍归 Codex。

## 改了什么

- **状态与记录**：只读同步控制器的状态文件与调度暂停标志，生成控制台的同步状态（上次成功、上一轮、正在运行、暂停原因）和历史轮次。失败原因只显示大写原因代码。
- **下架**：包装固定运行副本里的现有下架工具。计划同步执行；执行与续办交给独立后台进程，进度读自下架工具自己的日志文件；结果未知或部分完成时可续办，未开始的失败不提供续办。
- **控制台**：定时同步暂停时显示原因；新增“这一轮没有完成”的错误说明。

## 验证

- `tests/console-bridge.test.ts` 9 项通过（虚构状态文件、假的下架工具）；`tests/console-backends.test.ts` 13 项通过；类型检查与隐私检查通过。
- **真实状态（只读）**：在本机用私有配置接上真实同步状态文件，控制台登录后总览与记录页正确显示：上次成功同步为墨尔本时间 10 月 23 日 06:20，之后各轮失败及原因代码，调度暂停且上一轮失败、等待人工核对。只读取了本机文件，没有连接数据库、Dagu 接口或 Notion，没有改变任何文件。1280 宽无头 Chrome 检查。
- **下架只用假工具验证过**，真实下架尚未接通，见下。

## 局域网访问（补充）

用户希望局域网里的 MacBook 也能打开控制台。本机私有 env 改为监听 Mac mini 的局域网地址，允许的主机加上该地址与 Bonjour 名称；从局域网地址登录、未知主机 421、接口未登录 401 均已核对。README 补充了局域网方式与 HTTP 不加密的说明。

## 限制与下一项

- 网站已切换到新数据库，现有的 operator env 文件属于切换前或切换准备阶段，新库的受限下架账号尚未确认，所以真实配置里下架保持关闭。确认账号与 env 后再开启，并只用用户批准的测试页做一次真实验收。
- 控制台与私有配置目前放在这个工作区的 `.local/console-bridge/`；长期运行需要放到固定位置（例如与其他运行副本一样的固定目录），另行安排。
- 桥接命令读取的是 Codex 维护的控制器状态格式（`status`、`history[].status/startedAtUTC/finishedAtUTC/reason`、`nextDueAt`、暂停标志路径），格式变化需同步修改 `sync-status.ts`。
