# qualified 旧发布的父子共享预算

执行者：Codex。新增可选入口覆盖旧 `qualified/notion` 回退发布中的父进程、采集子进程及子进程加载的存储续期模块。代码准备不代表真实回退已获执行授权、已安装或已经成功。运行条件仍由后端发布拥有方冻结和交接。

## 入口与输入

使用 Node 24，从已经验证且包含本入口的冻结 release 执行：

```sh
node scripts/website-sync/qualified-budget-cli.ts \
  --config /PRIVATE/runtime.json --budget /PRIVATE/budget.json \
  --ledger /PRIVATE/fresh-operation-ledger --mode publish --check
```

默认与 `--check` 都只做离线检查：读取原 runtime、来源摘要、release manifest、私有凭据及辅助程序摘要，检查预算格式；不创建账本、不启动子进程、不续期、不连接云端。实际单次运行必须显式使用 `--execute`。`--help` 不读取配置。

预算文件和其目录分别须为当前用户的普通 600 文件和非符号链接 700 目录。输入为 `qualified-budget-input-v1`，包含且仅包含：

| 字段 | 规则 |
| --- | --- |
| `runtimeSha256` | 原 runtime **实际字节**的 SHA-256；再次进入旧入口时复核 |
| `storageOrigin` | 原 writer 的 `STORAGE_URL` 的 HTTPS origin，包含同项目 `/auth/v1` 续期；不能指向 Notion |
| `durationMs` | 一次操作的总窗口，10–5,400,000 毫秒；不是每进程分别计时 |
| `cleanupMs` | 停止后的清理窗口，0–20,000 毫秒 |
| `limits` | 下表全部十六项显式非负整数；零表示禁止 |

| 预算项 | 统计边界 |
| --- | --- |
| `notionRequests`、`storageRequests`、`authRequests`、`imageRequests`、`httpRequests` | 发出请求前持久预留，每次重试及显式图片跳转另计；失败不退款；被预算拦住的请求不计为已发尝试 |
| `notionResponseBytes`、`storageResponseBytes`、`authResponseBytes`、`imageResponseBytes` | 实际收到的正文块，包括错误、被忽略的上传／续期回复、取消后已收到的块；触发上限的最后一块也记入，因此终态可能超过上限 |
| `uploadBodyBytes` | 已知完整请求正文的保守预留，包括 Notion JSON、认证 POST、图片上传；失败不退款，不支持未知长度流式上传 |
| `sqlRequests`、`sqlRequestBytes`、`sqlResponseBytes` | pg query 调用、SQL/参数 JSON 和结果 rows JSON；Pool 和内部 Client 两层都保守收费，常规一次 SQL 可计两次 |
| `cleanupSqlRequests`、`cleanupSqlRequestBytes`、`cleanupSqlResponseBytes` | 独立清理预留；最多四次 query 调用，输入与回复各最多 64 KiB |

HTTP 总次数与普通 SQL 调用次数各最多 50,000，其余字节预算最多 16 GiB。这些是输入硬上限，不是默认执行额度。原 runtime 的单轮时长、2 GiB 去重媒体限制、来源范围及原服务端租约限制仍同时生效。

## 父子与取消

旧入口默认行为不变。只有显式选择新入口才传递固定 preload 路径和四项账本上下文；不继承 `NODE_OPTIONS`、shell 私有变量或自选 importer。父子绑定父 PID、随机 nonce、计划摘要及 runtime 摘要，只允许原父进程和其直属子进程。

账本目录只能新建一次。计数先持久写入，再交给原 HTTP／SQL 端口；更新通过短暂排他锁、文件与目录 fsync、原子替换完成。锁冲突或账本不确定立即停止，不抢锁、不退款、不重新开始。独立不可覆盖的停止标记使计数锁繁忙时其他进程也能看到停止。保留账本与原私有发布回执。

安装守卫早于 SDK、下载器及续期模块导入。Notion 与 Storage 走原 fetch；fetch 禁止隐藏重定向，回复按原状态与头返回，单条回复最多 2 MiB Notion／1 MiB Auth／20 MiB 其他内容。图片保留原下载器已验证 IP、逻辑 Host/SNI、TLS、显式跳转和重试策略，正文在原 HTTPS 流生产处收费。

超时、取消、额度耗尽或其他守卫失败停止 HTTP，并进入原 SIGTERM 清理路径。普通 SQL、stage、promote 与续期都不能再开始。只有精确的 `SELECT nb_v2_api.fail_run($1,$2) AS result`，且传入 run UUID 和非负整数 fence，能使用独立清理预留；清理时间从最早停止时间或原总 deadline 算起。现有 pg 连接／语句／查询超时保留，已发 SQL 不会因本地取消而被假定没有提交。

这不是通用网络隔离沙箱：仅覆盖当前已审查 worker／辅助模块使用的 fetch、原生 HTTPS 及 pg query 端口。HTTP/SQL 正文字节是应用层保守统计，**不包含协议头、TLS、PG 认证／错误帧或平台计费字节**；SQL 超额只能在结果取得后阻止继续，不能撤销已发查询。自定义 pg Query 对象不支持。实际凭据、URL、SQL 内容、Token 和页面标识均不写进预算回执。

## 发布拥有方交接条件

1. 选定新冻结 release 及其 Node／双锁文件摘要；原已安装旧 release 没有此入口，不能只加参数就假定预算存在。
2. 绑定原 runtime、来源、writer／reader 私有输入、续期模块与转换器；选定具体总时长和十六项额度。固定来源范围与原状态目录，不用新锁目录绕过既有 writer。
3. 确认原调度／手动 writer 已交接，检查原 canonical host 锁、writer-session 锁及云端租约。观察到本机锁不存在，只证明该次文件观察，不证明租约空闲。不得抢锁或接管他人的未决发布。
4. 保留原发布／reader 核对回执和租约 fence；结果不明时先核对服务端指针，不自动重发 promote、不重采、不自动回退。
5. 真正回退必须按原公开范围获得一次**新鲜 qualified 发布**及读取验收。恢复旧 policy／环境变量不会复活已失效的旧批次。

这里不改变 [完整发布的 HTTP 守卫](HOST_HTTP_BUDGET.md)、[独立媒体验收](INDEPENDENT_MEDIA_ACCEPTANCE.md)、公开政策、调度或网站模式，也不安装运行包。首次维护切换与真实回退的具体执行仍留给发布拥有方在媒体及运行输入齐备后推进。
