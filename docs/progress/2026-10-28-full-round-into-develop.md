# 2026-10-28：整轮同步代码并回 develop（Claude）

编辑登记：Claude 合并 #38（影视评分政策）与 #49（整轮完整采集）到最新 develop，并移植恢复期只存在于运行包里的补丁。改动 `scripts/website-sync/`（run.ts、run-private.mjs／.d.mts、qualified-budget-cli.ts、download.ts、runtime-sql.ts、worker.ts、full-collection-control.ts，新增 writer-session-invocation.ts）、`scripts/notion-sync/download.ts`、相关测试与三个源码指纹测试助手。页面、组件、契约、接口路由、依赖、数据库迁移与栏目开关未改。用户 2026-10-28 批准“第一阶段”，与 Codex 的分工另行确认。

来由：整轮同步实际运行的是 10-25 打包的独立运行包，它由 10-23 的 develop、未合并的 #49／#38 和约十个恢复期补丁组成；develop 里没有整轮采集代码，后续的 @用户 中性化（#115）、页面提及（#144）和冻结支持都无法进入整轮同步。先让 develop 拥有与运行包相同的整轮行为，再从 develop 重新打包。

## 合并与冲突

- #38 无冲突。#49 与 develop 有五处冲突：`run.ts`（develop #88 把启动检查移进 try，#49 在原位置加整轮准备）按 develop 结构保留，整轮准备移到读取来源配置之后，`fullCollection` 在 try 之前声明以便收尾使用；`run-private.mjs`（develop 改为内存传递凭据环境，#49 仍写临时文件并新增 owner broker）采用 develop 的内存方式加 #49 的 owner broker 与 IPC；需求文档两边都保留；两个测试助手的源码指纹按最终文件重算。

## 移植的恢复期补丁（原只在运行包中）

- 整轮零业务重试：Notion 客户端 `retry:false`（develop 已有）、Notion 只读请求有界重试 `transient-request-v1`（develop 已有，本项在整轮时开启）、图片下载单一地址、租约续期不重试、续期失败后停止计时器；回执记录四项重试政策。
- 图片 GET 有界重试 `transient-get-v1`：仅整轮且 `retry:false` 时，对网络错误、自身超时及 500／502／503／504 最多三次（等待 2 秒／5 秒），拒绝与限流不重试；与 develop #86 的“限流等待超过 120 秒即停止”合并，非整轮行为不变。响应头超时整轮为 60 秒。
- 采集时限 3 小时（10800 秒）：run.ts、run-private.mjs、full-collection-control.ts、qualified-budget-cli.ts。
- 写入会话续期最多 3 次（新增 `writer-session-invocation.ts`）。
- 整轮不做发布前的页面修复重采（仍保留新鲜度检查，修订号变化即停止）。
- 同步使用自己的隔离公开 reader 登录（#102 `sync-public-reader.ts`），不再按网站 reader 身份核对。
- run-private 的原生子进程上下文（`nativeChildContext`）与整轮 owner 上下文类型。
- 未移植：`connection.ts` 的 `websiteReaderRole`（只供旧非隔离入口使用）及其测试；`writer-storage-session.ts` 的旧版公开密钥识别（develop #193 已覆盖）。

新增测试（来自运行包）：`full-collection-zero-retry`、`writer-session-invocation`、`writer-session-series`、`recovery-acceptance-contract`。

## 验证

Node 24.21.0 本机：typecheck 通过；隐私检查通过（2,181 个文件）；全量测试 3,217／3,217 通过；build 通过（49 个服务端追踪不含私有运行文件）。定向：整轮与评分相关 7 个测试文件 100 项、采集兼容性与指纹相关 5 个文件 51 项通过。

测试随之调整：两项时限测试由 7200 秒改为 10800 秒；`renewal-capture-transition` 采用运行包中已适配零重试的版本；三个源码指纹助手按最终文件更新（与 develop 以往改动这些文件时的做法一致）；#49 与运行包带来的三处虚构凭据改为隐私扫描接受的占位写法（变量名不变，测试逻辑不变），未改隐私规则或其放行清单。

## 限制与下一项

- 这只让 develop 具备与现行运行包相同的整轮行为，没有冻结支持；冻结感知整轮是第二阶段（Codex）。
- 尚未用于真实同步。下一步从 develop 重新打包并改写同步执行器（入口改为 `run.ts`、重新生成程序与依赖清单），离线准入与演练通过后，用第 60 次真实验证。
