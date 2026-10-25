# 控制台与后端的对接协议

记录日期：2026-10-25。状态：控制台一侧已实现（`console/lib/bridge-backend.ts`），后端一侧的桥接命令尚未实现。背景与功能见[控制台方案](ADMIN_CONSOLE_PROPOSAL.md)，运行方式见 [console/README.md](../console/README.md)。

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
| `status` | `{}` | `SyncStatus`：发布模式、能力开关、正在运行的操作、上次成功时间、上一轮、下次定时、队列数、当前发布版本时间 |
| `sync.start` | `{ target: string \| null }` | `{ operationId }`；`target` 为空表示整轮 |
| `content.sections` | `{}` | `SectionSummary[]`：每个栏目的顶层公开数量与冻结数量 |
| `content.list` | `{ section, parentId, search }` | `{ items: ContentItem[], total }`；`parentId` 为空取顶层；`search` 非空时按标题搜索整个栏目，忽略 `parentId` |
| `target.resolve` | `{ input }` | `ContentItem` |
| `freeze.preview` | `{ target }` | `FreezePreview`：页面数、图片数、仍依赖 Notion 的图片、`digest` |
| `freeze.start` | `{ target, digest }` | `{ operationId }` |
| `unfreeze.preview` | `{ target, mode: "once" \| "permanent" }` | `UnfreezePreview`：将重读的页面数、会被覆盖的控制台修改、Notion 中已找不到的页面、`digest` |
| `unfreeze.start` | `{ target, mode, digest }` | `{ operationId }` |
| `takedown.plan` | `{ input }` | `TakedownPlan`：计划 ID、目标、后代数、图片数、过期时间 |
| `takedown.execute` | `{ planId }` | `{ operationId }` |
| `takedown.resume` | `{ planId }` | `{ operationId }` |
| `operation.get` | `{ id }` | `Operation`：类型、目标、来源（定时／控制台）、状态、步骤、计数、错误、可续办的计划 ID |
| `operation.list` | `{ limit }` | `Operation[]`，最新在前，含定时同步 |

`target` 与 `input` 接受站内页面地址（路径或完整地址）、Notion 页面链接，或 `content.list` 返回的 `id`。`id` 对控制台不透明，不能是 Notion 地址。

## 约定

- **能力开关。** `status.capabilities` 说明后端已经支持哪些功能（`sync` 整轮立即同步、`targetedSync` 单页同步、`freeze` 冻结与解冻、`takedown` 下架、`contentList` 内容列表），控制台据此停用按钮或显示“还没接上”。可以分批接入：例如先实现 `status`、`operation.*` 和下架，冻结等新模式上线后再打开。未支持的操作返回 `UNSUPPORTED`。
- **预览绑定确认。** `*.start` 必须带上预览返回的 `digest`。范围、图片状态或冻结状态在此期间变化时返回 `PREVIEW_STALE`，控制台会请用户重新查看。
- **启动不等待。** `*.start` 和 `takedown.*` 只登记并启动工作，立即返回 `operationId`；控制台每 1.2 秒调用 `operation.get` 直到状态结束。
- **同一把锁。** 同步、冻结、解冻和下架与定时任务共用现有的锁；已有写入在进行时返回 `BUSY` 并带上 `runningOperationId`，不排队、不抢锁。
- **结果未知。** 写入已发出但没有确认时，操作状态为 `unknown`、错误码 `OUTCOME_UNKNOWN`。下架带上 `resumePlanId`，控制台提供“继续下架”，调用 `takedown.resume`；其他操作只提示核对，不自动重试。
- **审计。** 每个经控制台发起的操作都应出现在 `operation.list` 中，定时同步也应出现，`trigger` 区分来源。

## 错误码

`BUSY`、`NOT_FOUND`、`NOT_PUBLISHED`、`ALREADY_FROZEN`、`NOT_FROZEN`、`PREVIEW_STALE`、`MEDIA_NOT_READY`、`PLAN_EXPIRED`、`UNSUPPORTED`、`INVALID_INPUT`、`OUTCOME_UNKNOWN`、`UNAVAILABLE`。控制台为每个码显示固定的中文说明（`console/lib/types.ts` 的 `errorText`），再附上 `message`。其他码一律当作 `UNAVAILABLE`。

## 验证方式

`tests/console-backends.test.ts` 用临时脚本充当桥接命令，覆盖请求格式、错误码透传、未知码与坏回复、环境不外传和相对路径拒绝。后端实现桥接命令后，可用同样的方式先在本机以假数据核对，再接真实运行器。
