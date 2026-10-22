# 固定同步版本与调度准备

运行代码使用内盘独立 `Services/notionblog-sync/releases/<commit>`，来源、凭据和原有 state 仍在受保护配置根。发布使用已提交的源码和锁文件安装依赖，记录 commit、逐文件摘要、Node 绝对路径／版本／摘要及转换器摘要；不从开发 worktree 或 `current` 符号链接直接启动。`current` 仅标识已验收版本，未验收候选不切换它。

## 分开的私有输入

新增主机适配入口 `scripts/notion-sync/run-private.mjs`，复用现有 `notion-readonly.env`、`supabase-worker.env`、`notion-sources.json`、`refresh-writer-session.mjs` 与 `bin/heic-to-jpeg`。它不提供新的凭据、不替换主机的续期模块，也不安装调度。输入根与 state 必须是规范绝对路径、当前用户拥有、700 且不是符号链接；凭据／来源／续期模块为 600。

```sh
"$NODE" "$RELEASE/scripts/notion-sync/run-private.mjs" \
  --project "$RELEASE" --private-root "$SYNC_PRIVATE" --state-dir "$SYNC_PRIVATE/state" \
  --mode publish --media-provider notion --check
```

`--check` 只检查本机路径、输入存在性／语法和运行参数，不联网、不续期、不锁定、不启动 CLI；不能当作 SQL 扩展、Notion 权限或真实同步验收。先核对发布清单，再手动执行 [混合媒体启用流程](HYBRID_MEDIA.md) 的迁移、严格采集／暂存、完整发布和受保护预览。

模式默认 `dry-run`，媒体默认 `storage`，两者都由显式命令行优先；本次主机候选明确使用 `--media-provider notion`。这不会自动改变网站的 `MEDIA_PROVIDER`。`stage`／`publish` 在独占输入根 `manual-run.lock` 后，通过原续期模块轮换唯一权威会话，并要求 JWT 至少剩余 35 分钟。它先拒绝已有 `worker.lock` 或 `writer-session.lock`，不抢锁。CLI 继续取得同一 state 的业务锁和数据库 lease；直接绕过适配器调用 CLI 仍会跳过输入根锁，运维只使用登记的统一入口。

适配器将合并配置写入输入根 600 临时文件，子进程只继承固定 PATH，不继承 shell／网站凭据或 Node 选项。凭据不进入命令参数、报告或网页。正常完成、启动失败或取消后清理自己的临时文件和锁；锁清理核对 inode，不能删除另一个实例的锁。进程被强杀／断电可能留下文件和锁，停止所有入口后先检查，再处理明确属于该次运行的残留，不自动偷锁。

## 唯一调度与停止

`templates/private-launchd.plist` 是分开私有输入的候选，默认混合图片、dry-run，未设置 `StartInterval`，`RunAtLoad=false`、`KeepAlive=false`。替换占位符并 `plutil -lint` 只证明 plist 格式，不代表任务已安装。手动与 launchd 使用同一适配器、输入根及 state，不另设 cron 或第二个重试器。

公开 TTL 仍为每批次开始起 3600 秒。间隔必须加上实际最长同步时间和恢复余量；混合图片减少 Storage 传输，不会减少 Notion 正文请求或取消完整图片验签。原 Storage 模式一轮约 388 MB，半小时一轮的约 18.6 GB／天回读估算不适用于混合模式；新方案应测实际转换图字节、耗时和 Notion 失败情况后选周期。任何频率都不能保证主机睡眠、断网或上游故障时持续在线；资格过期继续受控拒绝，不延长 TTL 掩盖失败。

启用前将候选 mode 改为已验收的 `publish`，增加用户确定的 `StartInterval`，记录主机唯一入口／状态／备份映射，才放入用户 LaunchAgents 并 bootstrap。暂停使用同一 plist 的 `launchctl bootout`；检查用 `launchctl print` 和原 CLI 的 `--status`。SIGTERM 传给子进程，等最多 30 秒后强制结束；CLI 有 1800 秒协作预算，适配器在 1860 秒发终止、再等 30 秒。中断后核对云端 run／lease，不能仅凭非零退出断言 promote 未提交。重启不立即执行，睡眠漏掉的触发不保证补齐。

本轮没有添加远程消息告警。匿名 latest-run／last-success 和已有日志可人工审计；正式启用时须确定告警收件方式及去重，不擅自向他人发送通知。

严格混合发布完成后，另准备了未安装的 [半小时调度候选、实测成本与故障处理](SYNC_SCHEDULE.md)。候选明确 publish／notion，不覆盖原 dry-run 模板；普通图完整校验下载仍然存在，不能沿用旧 Storage 流量标签。离线检查与私有 plist 格式验证不会安装或加载任务。

## 图片恢复范围

旧 v1 内容归档不包含图片字节。单独备份归档中去重对象，下载后与磁盘读回均验证 MIME、大小和 SHA-256，最后写完成清单。离线恢复演练把这些字节复制到新的私有目录，逐个再次验证，同时核对内容归档与描述清单摘要。云端不上传／删除，未引用残留对象不在该备份范围。

这个恢复点针对已完成的旧 Storage 批次；混合模式新增普通图没有 Storage 对象，不能沿用它宣称覆盖未来新图。新的混合图片备份流程与图片任务协调，核心 JSON／定位索引／转换图备份都不能单独算全量媒体灾备。内盘本机备份和读回也不代表异地或外部备份已验证。
