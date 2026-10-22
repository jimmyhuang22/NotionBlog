# 社交封面待办与统计接线

此模块补充[社交封面](SOCIAL_WORK_COVERS.md)，不替代现有统计采集器、媒体处理器或公开资格。默认关闭，尚未安装的候选不得称线上自动补图已完成。

## 输入与持久化

社交运行根可显式配置私有 `social-cover-policy.json`：`{"version":1,"enabled":true,"mode":"retained"}`。仅接受这三个字段；没有文件或 enabled=false 时，采样 hook 不创建队列。`trial` 与 `retained` 独立，不混用资格。

精确统计回执及本地 ACK 后生成 publication 待办；合集在同次 HTML 已完成身份与完整成员校验后，只暂存 cover sidecar 和统计快照 SHA，只有相同 snapshot 的 ACK 才变成可消费任务。缺旁记录写来源缺口，不能把代表视频图片或别的作品图片猜成合集封面。B 站原周期／新投稿与小红书原周期／新笔记／浏览器补采均通过既有接入点。

独立状态放在运行根的 `social-cover-queue/`：

- `social.sqlite` 保存最新待办、受检 generation、处理状态、最后尝试与固定错误码；不迁移统计源库。
- `health.json` 只含 pending、failed、complete、missing、暂存合集与缺来源数量、最后尝试时间／原因，可供后台只读展示。它不是全局统计待办数。
- `hook-error.json` 为最近一次接线失败的历史时间／固定原因，与消费者当前 failed 数分别解释，不能因后续其他作品成功而宣称该错误已修复。
- `latest-run.json` 保存一次媒体消费者真实结果，不包含来源 URL 或原始错误文本。

同一完整 URL 的普通发布已处理后，新统计只更新最新观察；不重复取图。合集的合法来源还绑定当前观察时间，所以新 ACK 会排队更新来源时间；现有绑定 digest 相同由 worker 直接 unchanged，零源 GET／编码／PUT／对象回读。处理期间的新引用不会被旧任务完成清除。null 封面记 missing，不伪造占位图片。

## 操作

`node scripts/social-media/queue-cli.ts --help` 显示入口。以下 `RUNTIME`、`MEDIA` 均为操作者提供的绝对私有目录，不是环境变量默认值：

```text
queue-cli.ts status RUNTIME
queue-cli.ts plan RUNTIME
queue-cli.ts seed-bilibili RUNTIME --execute
queue-cli.ts seed-xiaohongshu RUNTIME --execute
queue-cli.ts sync RUNTIME MEDIA --execute
queue-cli.ts retry RUNTIME --execute
```

status／plan 不读取媒体凭据，不创建云连接或请求来源。seed 只读当前允许范围内与最新本地统计 SHA 匹配的已 ACK 记录，不写来源历史、不联网；合集没有同次旁记录只记 gap。它也可用于修复统计 ACK 与媒体本地写入间的崩溃缺口。seed 输出 executed=false 表示没有来源／云执行，但会修改本地媒体待办。

sync 使用 MEDIA 中的私有 `media.env` 与 `cache/`，复用最小媒体角色及真实资格校验。周期入口要求 `SOCIAL_MEDIA_STORAGE_WRITER_EMAIL/PASSWORD/USER_ID` 和独立的 `SOCIAL_MEDIA_STORAGE_READER_EMAIL/PASSWORD/USER_ID`；两账号不能相同，每批在内存中各自按需建立密码会话并核对 Auth 当前用户和专用 social app_metadata，不持久化 access／refresh token，不回退旧静态写 Token。旧手动 CLI 的显式静态输入路径保持原样。

无 pending 时不读取媒体凭据、鉴权或连接数据库。消费者既持有队列独占锁，也与旧媒体 CLI 共用 MEDIA 独占锁；统计生产者不持有这两把消费锁，继续按自己的源库锁运行。结束时关闭本次创建的本地 Auth 会话及数据库连接，不全局注销同账号或网站会话；注销不能视为已发 JWT 立即失效。单轮最多二十项，整轮共用既有八十 MiB／一百二十次逻辑对象操作／三分钟上限，不能把逻辑对象数当作 Auth、冲突读回及网络内部请求的完整物理计量。

单轮剩余不足三十秒时不再派发下一项，未处理项保持 pending，结果中的 deferred 只表示正常顺延，不算失败。已被新 generation 替换的旧任务即使触发来源资格拒绝，也只计 superseded；新任务继续保留。三分钟硬期限及真实失败保护不放宽。

真实首错保留当前 failed 和后续 pending；同引用新统计不自动清除失败。retry 仅把当前模式下最旧最多二十个失败重置为 pending，不取图或上传；随后下一次明确 sync 才执行。新完整 URL 可形成新的 pending，但不是无限网络重试。

## 安装和验收边界

先冻结具体源码、模式、当前账号／来源清单、媒体凭据身份、独立批次预算和固定调度指针，再有限验收取图／复用／上传／登记／网站400与800。不得借旧媒体 token、旧关闭窗口或他方对象预算启用。源 URL 改变必须先证明新 URL 的原件字节，才可复用旧编码；不剥签名参数。

本模块不安装 Dagu、不切换 Native Host 或扩展、不改网站配置、不恢复暂停的网站内容同步。新增任务不需要重采全部统计或再次生成已完成的其他媒体。尚未取得合法来源、作品撤回、图片拒绝等项保留真实缺口，不能仅因源范围有作品便保证每张都有可用封面。
