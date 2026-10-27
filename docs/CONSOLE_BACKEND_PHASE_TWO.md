# 控制台第二阶段后端

更新：2026-10-27。用户已确认继续实施，见[冻结决定](decisions/2026-10-27-console-freeze-and-sync.md)。本轮提供源码、隔离验证与安装入口，尚未在实际数据库安装或切换控制台服务。界面与协议沿用[控制台方案](ADMIN_CONSOLE_PROPOSAL.md)和[桥接协议](CONSOLE_BRIDGE.md)。

## 使用效果与边界

立即同步执行一个有界增量周期；单页按钮只领取指定页面及必要依赖，`resume` 仍只解除人工检查。控制台从真实发布状态、队列和操作记录区分完成、待办、失败和结果不明。

冻结保留当前发布的目标及后代、正文、原图和当时已登记的小图。冻结成员跳过来源采集，新的 Notion 子页面不自动加入。永久解冻把原成员放回队列；“同步一次”在新内容原子提交成功后更新冻结版本，失败保留旧版。中央 deny、祖先 deny、栏目关闭及来源授权撤销继续优先。

独立冻结扩展记录组、成员快照、版本与操作账本。预览绑定发布版本、成员、媒体、中央 deny 和冻结版本；解冻另绑定来源身份、编辑时间和归属，变化后须重新预览。PostgreSQL 发布指针触发器防止旧 publisher／完整同步覆盖或遗漏冻结记录，可选小图触发器保护被冻结的派生对象。网站仍从同一个持久发布版本读取列表、搜索、内部链接与媒体。

同步一次复用原增量事务、独立 reader 和 checkpoint 恢复。回执丢失先查询原 operation，不重放写入。沿用每次最多 100 条变更记录／媒体／撤回，学习组最多 2,000 次准备读取，还受本轮时长与字节预算限制，超限要求人工检查。未冻结祖先被删除而其后代已冻结时，当前实现拒绝该准备操作，需先处理冻结组。

原图和已登记小图都核验实际字节；缺档或损坏不冻结。冻结不负责生成尚未登记的小图，图片变更后的派生图仍由既有媒体流程准备。重叠冻结组拒绝。

## 本机接线

桥接配置增加可空的 `management`，含固定 Node 24 `node`、代码目录 `project`、私有 `envFile` 和 `configFile`，全部使用绝对路径。未配置时保留第一阶段。桥接子进程只继承 PATH、HOME、NODE_ENV，浏览器不能指定命令、SQL、凭据或文件路径。

管理配置示例（替换路径，文件权限 600）：

```json
{
  "version": 1,
  "enabled": true,
  "stateDir": "/absolute/project/.local/console-management",
  "lockDirectory": "/absolute/private/canonical-worker-state",
  "runtimeDirectory": "/absolute/private/incremental-runtime",
  "sourceConfigPath": "/absolute/private/source-config.json",
  "siteOrigin": "https://example.test",
  "durationMs": 120000,
  "mediaBytes": 67108864
}
```

执行环境要求 `SYNC_PUBLICATION_MODE=published`、`SYNC_MEDIA_PROVIDER=storage`、`SYNC_FREEZE_ENABLED=1`，独立增量 reader／writer，以及 `CONSOLE_OPERATOR_DATABASE_URL`。管理 LOGIN 只加入 `nb_freeze_operator`，不能兼任 writer、reader 或 owner、持私表权限；运行时核对实际身份及来源摘要。owner 凭据只供显式维护命令。

```sh
node --env-file=.local/owner.env scripts/console-management/admin.ts install --config /absolute/private/management.json
node --env-file=.local/owner.env scripts/console-management/admin.ts enable --config /absolute/private/management.json
```

`install` 默认停用，不创建 LOGIN、发布内容或恢复定时任务。若之后才安装可选小图扩展，再运行一次 `install` 补装保护；保护缺失时能力检查拒绝启动。`enable` 要求已有持久发布、匹配的本机增量基线、独立媒体及没有未确认工作，使用同一 worker 锁。按现有隔离流程配置管理 LOGIN，不把凭据传到浏览器。

实际采用还需现有持久发布／独立媒体接入完成、指定真实验收课程，并核对运行配置与图片规模。批准覆盖同一任务，不另建执行线重复当前内容恢复。

## 配套备份恢复

有冻结扩展时数据库使用 `notionblog-publication-archive-2` 保存成员和操作，无扩展保留格式 1。旧工具遇到扩展拒绝，不能遗漏后宣称完整。

owner 命令在原 worker 锁内将[发布归档](PUBLICATION_RECOVERY.md)与本机 SQLite 队列、学习 checkpoint、正文 cache、ready 配套保存。本机部分上限 192 MiB，只接受来源／版本一致且没有未确认提交或未完成收尾的文件。配置和凭据另行保管。

```sh
node --env-file=.local/owner.env scripts/console-management/admin.ts export --config /absolute/private/management.json --path /absolute/project/.local/backups/new
node --env-file=.local/owner.env scripts/console-management/admin.ts export --config /absolute/private/management.json --path /absolute/project/.local/backups/new-with-media --media
node scripts/console-management/admin.ts verify --path /absolute/project/.local/backups/new-with-media
node --env-file=.local/restore-owner.env scripts/console-management/admin.ts restore --config /absolute/private/empty-target-management.json --path /absolute/project/.local/backups/new-with-media
```

`verify` 完全离线，验证数据库结构、SQLite、文件摘要及包含的图片字节。`--media` 可读 Supabase、COS 或本机副本中的原图和派生图；历史 Notion-only 图仍使用原归档定位器。缺档或损坏使备份失败，真实批量备份按实际规模批准。

恢复要求匹配的空数据库和全新 runtime 目录，先准备本机文件，再原子恢复数据库。SQL 结果不明时保留停用的本机目录供核对，不自动重试。恢复清空发布指针、关闭冻结，ready 改存为 `restored-ready.json` 并标记需要重建基线，旧队列不能自动重放。重新核对当前授权、建立基线并明确发布；该命令不上传图片、不安装调度。
