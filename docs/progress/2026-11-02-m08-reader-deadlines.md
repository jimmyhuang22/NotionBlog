# 2026-11-02：M08 读取事务超时与独立归档期限（Codex）

用户批准“先修 M08，按方案离线实现和验证，通过后合入 develop，先不发布”。本项从最新 develop `0bebe34` 开独立分支；只改网站读取及运维 CLI 的源码／测试和对应文档，未动现役后台包或真实配置。

## 编辑与接口

读取层修改 `request-query.ts`、`connection.ts`、content／social runtime、direct-policy runtime、自托管与 reader CLI；新增专用 `readerSqlExecutor`。共享 `sqlExecutor` 仍供原同步 writer 使用。业务 SQL 与 DTO 不变，在同一 checkout 内增加 BEGIN READ ONLY／SET LOCAL／COMMIT；失败按剩余期限回滚，确认不了则销毁本次连接。服务端上限网站 15 秒、社交 10 秒，且不得超过剩余请求期限；没有 HTTP budget 的读入口同样受限。

新增控制命令计入通用 SQL 数量及逻辑行字节。私有就绪保留 8 条业务语句，并明确最多 32 条总 SQL，8 秒／256 KiB 不变；搜索原 4 条业务结果／13 MiB 不变。调整 route／PGlite 注入夹具以确认控制命令，保留原业务 SQL、媒体、撤回及错误断言。

新增 `scripts/owner-archive.ts`，接入 v1、v2、publication 三个归档 CLI：单连接 owner 池，显式设置并读回 session 超时；export SQL 60 秒／query 65 秒／进程 300 秒，restore SQL 120 秒／query 125 秒／进程 30 分钟，连接 20 秒／锁 5 秒。已知 Supabase 事务池拒绝，必须 direct/session。verify 保持离线；恢复到期或 COMMIT 确认失败保留固定 unknown 错误，不重试。原归档格式、空库限制、恢复后的发布停用及冻结字节未改。

长期选择写入[决定](../decisions/2026-11-02-reader-transaction-deadlines.md)，实现与采用边界见[说明](../DATABASE_OPERATION_DEADLINES.md)。状态表仅将 M08 改为源码／离线已交付，真实采用仍待发布和安装核验。

## Provider 与真实操作

沿用原 database v1/v2、社交与 direct-policy 接口，没有新 provider 或来源。本轮项目 Supabase／Storage／Notion／AWS 网站访问、云端 SQL／写入／出口均为 0；没有部署、改配置、接触现役运行包、重建私人 pin、恢复任务或安装迁移。GitHub 操作为正常源码交付。

日常原生 pg_dump 脚本保持原样，其 300 秒／400 MB 改造沿用已有 G1 成果，采用另行安排。本次没有读取／解密真实备份，也不把新 JSON CLI 当作日常 pg_dump 已安装。

## 验证与失败记录

- 新增 reader／owner 定向回归覆盖控制数量、剩余期限、并发隔离、回滚／销毁、取消、未知确认、搜索预算及 CLI 进程截止。
- 原生 PostgreSQL 17.11、真实 pg、夹具 CA 与主机名验证：过滤 startup GUC 后，原 2min 在事务内变为 15s／10s，同一后端归还后恢复 2min／read-only off；长查询收到 57014，回滚后连接可复用，只读写入被拒；确认查询 active 后取消一侧，不影响另一侧，并观察到无睡眠 SQL／idle transaction 遗留；owner 60s／120s 与锁 5s 均读回。环境为内部 Docker 网络、虚构数据，不能写成真实 Supavisor／生产验收。
- 初次 socket 测试被沙箱 EPERM 拒绝，使用获准的本机 loopback 权限后通过；两份 PGlite 集成首次因未加既有 offline guard 被入口拒绝，补齐启动环境后通过。Docker 默认子网耗尽改用显式内部夹具子网；内部网络不发布端口，因此在同网 Node 容器验证。首次挂载缺目录和一次重复夹具表错误修正后复验通过。未修改生产代码来放宽这些环境限制。
- 官方 Node 24.21.0 最终 `npm run check` 通过：3268 项、0 失败／取消／跳过，包含新增 16 项 reader／owner 回归，类型、lint、协议及隐私预检通过。`npm run build` 通过，49 条服务端追踪隐私检查通过；这两项均在离线演示环境执行，不是平台或生产验收。
- 完整验证的初次隐私预检拒绝两份新测试 URL 中的虚构凭据写法，改用已有 example 占位符后通过，未改扫描规则。随后一轮全量 3267／3268，唯一失败为历史 capture 测试固定的当前网站 runtime 摘要；更新测试当前摘要并增加新 reader 路径拒绝断言，5 项复验通过，旧兼容清单与放行函数不变。首次 build 又因工作树外部 node_modules 链接被 Turbopack 拒绝；改用同版本的工作树内依赖副本后，在最终环境完成上述完整 check／build。所有原失败日志保留，未通过修改 Next 配置或兼容协议放行。
- 收尾只改说明：记录格式 3 项、271 个本地链接、45 个主编号、差异及 2245 项隐私检查通过；不因纯文档收尾重复工程全套。平台检查与本机结果分别记录，不把本机成功写成平台成功。

## 局限与下一项

本轮只交付离线源码，生产先前观察的 2min 设置未被改变。发布后再小量核对真实事务池和全部入口，不重复真实全量采样。30 分钟是实现的 CLI 控制期限，尚非真实规模恢复时间；进程退出／连接销毁也不独立证明远端恢复结果，未知时只读分类后再决定。M08 的线上采用与现役原生导出仍单列，其他后端未结项未顺带实施。
