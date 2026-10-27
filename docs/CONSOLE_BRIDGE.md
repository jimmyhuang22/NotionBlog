# 控制台与后端的对接协议

记录日期：2026-10-25，更新：2026-10-27。控制台一侧与第一阶段桥接已实现；第二阶段冻结、受限增量触发和备份源码见[实施说明](CONSOLE_BACKEND_PHASE_TWO.md)，实际安装仍待持久发布与独立媒体采用。第一阶段由 Claude 按用户指定实现在 `scripts/console-bridge/`，见下文。背景见[控制台方案](ADMIN_CONSOLE_PROPOSAL.md)，运行方式见 [console/README.md](../console/README.md)。

控制台不直接连接 Notion、数据库、同步运行器或下架工具。它只调用一个由后端提供的**桥接命令**：每次操作启动一次命令，经标准输入写入一个 JSON 请求，从标准输出读取一个 JSON 回复。桥接命令由后端负责实现、安装和授权，控制台不需要知道私有路径、锁目录或凭据。

## 启动方式

- 控制台用 `CONSOLE_BRIDGE_COMMAND`（绝对路径）和可选的 `CONSOLE_BRIDGE_ARGS_JSON`（字符串数组）启动命令，不经过 shell。
- 传给命令的环境只有 `PATH`、`HOME`、`NODE_ENV`。命令需要的私有配置由它自己读取（例如固定的私有 env 文件），控制台的登录密码和会话密钥不会传过去。
- stderr 是命令自己的日志，控制台只读掉、不显示。
- 时限：读取类 15 秒，预览类 60 秒，启动类 30 秒。读取或预览超时按“暂时连不上”处理；启动类超时按“结果未知”处理，因为工作可能已经开始。
- 回复上限 4 MiB。

## 请求与回复

```json
{ "version": 1, "op": "freeze.preview", "input": { "target": "/study/example" } }
```

成功：

```json
{ "version": 1, "ok": true, "data": { "...": "..." } }
```

失败：

```json
{ "version": 1, "ok": false, "error": { "code": "BUSY", "message": "…", "runningOperationId": "…" } }
```

`version` 不是 1、不是 JSON、缺少 `data` 或形状不对，控制台都按 `UNAVAILABLE` 处理。`message` 是给操作者看的诊断说明，最多显示 500 字，不能包含凭据、来源 ID、私有路径或正文。

## 操作清单

字段类型以 `console/lib/types.ts` 为准；时间一律为 ISO 8601 字符串，未知时为 `null`，不补值。

| op | input | data |
| --- | --- | --- |
| `status` | `{}` | `SyncStatus`：发布模式、能力开关、正在运行的操作、上次成功时间、上一轮、下次定时、队列数、`hold`（定时同步暂停的原因，正常为 `null`）、当前发布版本时间、`contentValidUntil`（按旧模式规则内容算最新的截止时间，未知为 `null`） |
| `sync.start` | `{ target: string \| null }` | `{ operationId }`；`target` 为空表示整轮 |
| `content.sections` | `{}` | `SectionSummary[]`：每个栏目的顶层公开数量与冻结数量 |
| `content.list` | `{ section, parentId, search }` | `{ items: ContentItem[], total }`；`parentId` 为空取顶层；`search` 非空时按标题搜索整个栏目，忽略 `parentId` |
| `target.resolve` | `{ input }` | `ContentItem` |
| `freeze.preview` | `{ target }` | `FreezePreview`：页面数、图片数、仍依赖 Notion 的图片、`digest` |
| `freeze.start` | `{ target, digest }` | `{ operationId }` |
| `unfreeze.preview` | `{ target, mode: "once" \| "permanent" }` | `UnfreezePreview`：将重读的页面数、会被覆盖的控制台修改、Notion 中已找不到的页面、`digest` |
| `unfreeze.start` | `{ target, mode, digest }` | `{ operationId }` |
| `takedown.plan` | `{ input }` | `TakedownPlan`：计划 ID、目标、后代数、图片数、`syncBusy`（数据库的租约字段仍非空，过期也算；此时下架工具会拒绝，控制台停用确认）、过期时间 |
| `takedown.execute` | `{ planId }` | `{ operationId }` |
| `takedown.resume` | `{ planId }` | `{ operationId }` |
| `operation.get` | `{ id }` | `Operation`：类型、目标、来源（定时／控制台）、状态、步骤、计数、错误、可续办的计划 ID |
| `operation.list` | `{ limit }` | `Operation[]`，最新在前，含定时同步 |
| `jobs.list` | `{}` | `JobStatus[]`：其他定时任务的名称、调度说明、是否暂停、最近一次状态与时间、上次成功时间、失败的步骤名 |

`target` 与 `input` 接受站内页面地址（路径或完整地址）、Notion 页面链接，或 `content.list` 返回的 `id`。`id` 对控制台不透明，不能是 Notion 地址。

## 约定

- **能力开关。** `status.capabilities` 说明后端已经支持哪些功能（`sync` 整轮立即同步、`jobs` 其他定时任务、`targetedSync` 单页同步、`freeze` 冻结与解冻、`takedown` 下架、`contentList` 内容列表），控制台据此停用按钮或显示“还没接上”。可以分批接入：例如先实现 `status`、`operation.*` 和下架，冻结等新模式上线后再打开。未支持的操作返回 `UNSUPPORTED`。
- **预览绑定确认。** `*.start` 必须带上预览返回的 `digest`。范围、图片状态或冻结状态在此期间变化时返回 `PREVIEW_STALE`，控制台会请用户重新查看。
- **启动不等待。** `*.start` 和 `takedown.*` 只登记并启动工作，立即返回 `operationId`；控制台每 1.2 秒调用 `operation.get` 直到状态结束。
- **同一把锁。** 同步、冻结、解冻和下架与定时任务共用现有的锁；已有写入在进行时返回 `BUSY` 并带上 `runningOperationId`，不排队、不抢锁。
- **结果未知。** 写入已发出但没有确认时，操作状态为 `unknown`、错误码 `OUTCOME_UNKNOWN`。下架带上 `resumePlanId`，控制台提供“继续下架”，调用 `takedown.resume`；其他操作只提示核对，不自动重试。
- **审计。** 每个经控制台发起的操作都应出现在 `operation.list` 中，定时同步也应出现，`trigger` 区分来源。

## 错误码

`BUSY`、`NOT_FOUND`、`NOT_PUBLISHED`、`ALREADY_FROZEN`、`NOT_FROZEN`、`PREVIEW_STALE`、`MEDIA_NOT_READY`、`PLAN_EXPIRED`、`UNSUPPORTED`、`INVALID_INPUT`、`OUTCOME_UNKNOWN`、`RUN_FAILED`（用于操作记录里没有完成的同步轮次，原因写在 `message`）、`UNAVAILABLE`。控制台为每个码显示固定的中文说明（`console/lib/types.ts` 的 `errorText`），再附上 `message`。其他码一律当作 `UNAVAILABLE`。

## 第一阶段实现

用户 2026-10-25 指定由 Claude 完成第一阶段。命令为 `node scripts/console-bridge/cli.ts --config <私有 config.json>`，只用 Node 内置模块。

私有配置（不提交，0600）：

```json
{
  "version": 1,
  "stateDir": "/absolute/…/.local/console-bridge/state",
  "siteOrigin": "https://网站地址",
  "sync": { "stateFile": "/absolute/同步控制器状态文件", "suspendFlag": "/absolute/调度暂停标志", "schedule": "给人看的调度说明" },
  "jobs": { "dataDir": "/absolute/Dagu 数据目录", "suspendDir": "/absolute/Dagu 暂停标志目录", "list": [{ "dag": "任务名", "name": "显示名", "schedule": "调度说明" }] },
  "takedown": null
}
```

- **状态与记录**：只读同步控制器的状态文件和调度暂停标志，不连接数据库、Dagu 接口或 Notion，不改变任何同步。历史轮次的原因只显示大写原因代码，路径和其他文字不外传。控制器在上一轮失败或暂停标志存在时不会开始新一轮，`hold` 据此说明。发布模式按现状报告为 `qualified`；网站内容版本时间需要读数据库，第一阶段报告 `null`。
- **其他定时任务**：只读 Dagu 数据目录里各任务自己的运行记录（Dagu 的 HTTP 接口需要登录，数据目录不需要）和暂停标志目录，取最近一次状态、时间、失败的步骤名，并向前查找上次成功；不显示运行日志或错误文字。
- **内容列表**：读网站公开接口（`/api/content/<类型>` 与 `/api/study/<课程>/tree`），即访客已经能看到的内容，结果在 `stateDir` 里缓存 10 分钟；栏目数量只取各列表的 `total`。新模式上线前不知道冻结状态，所有公开页面都报告为 `syncing`。
- **失败原因**：已知的原因代码附带中文说明，原代码保留在括号里；未知代码原样显示。上次成功那一轮的回执里只读取 `validUntil`，作为 `contentValidUntil`。
- **下架**：`takedown` 为 `{ "node", "project", "envFile" }` 时启用。`project` 指向已固定的运行副本，命令原样调用其中的 `scripts/public-cache/withdraw-cli.ts`，用 `envFile` 提供受限 operator 账号、缓存设置和锁清单；不修改下架工具。计划同步执行（55 秒内），执行与续办由独立的后台进程完成，进度读自下架工具自己的日志文件（PLANNED → DENIED_PURGE_PENDING → PURGED_VERIFY_PENDING → COMPLETE；DENY_OUTCOME_UNKNOWN 为结果未知）。日志、计划和操作记录都在 `stateDir`，必须位于 `.local` 下。
- `takedown: null` 是未接线配置的安全默认值。现有控制台已接上受限 operator 与固定运行副本，并完成真实只读计划；真实下架与恢复尚未验收，见[接线记录](progress/2026-10-25-console-takedown-acceptance.md)。
- **发布后未完成**：识别控制器 `PUBLISHED_POST_INCOMPLETE`，报告整轮未完成并明确“内容已发布”，保留安全原因代码，不映射成写入结果未知或整轮成功。上次完整成功时间保持原值；若没有本次实际发布时间及有效期，则当前内容版本时间与有效期报告 `null`，不拿旧成功轮次的值代替。该状态阻止预测下一次定时运行。

后续冻结、解冻、立即同步及备份扩展见[第二阶段后端方案](CONSOLE_BACKEND_PHASE_TWO.md)，方案尚待确认。

## 验证方式

`tests/console-bridge.test.ts` 用虚构状态文件和假的下架工具覆盖第一阶段实现：状态与历史、暂停原因、能力开关、计划与后台执行、结果未知后续办、未开始的失败、坏输入与路径越界。`tests/console-backends.test.ts` 用临时脚本充当桥接命令，覆盖请求格式、错误码透传、未知码与坏回复、环境不外传和相对路径拒绝。后端实现桥接命令后，可用同样的方式先在本机以假数据核对，再接真实运行器。
