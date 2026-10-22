# 固定社交刷新执行器

本项复用已完成的固定计划／发送前守卫，接入现有采集、SQLite 和受限 SQL 上传。每次只处理指定平台的固定目标，最多二十项，120 秒取消预算；公开 B 站请求另有共享 32MiB 读取上限和一秒间隔。进行中的 SQL 有原十／十二秒超时，取消后会完成连接清理。无需新增数据库、HTTP 服务或守护进程。

## 私有运行目录

准备 700 的运行目录和 600 的 `refresh-config.json`、`cloud.env`。固定配置沿用[刷新说明](SOCIAL_REFRESH.md)，来源路径指向已有两个 SQLite 状态目录；云凭据使用现有 `nb_social_worker`，按原 TLS／角色／协议检查，不使用 owner、reader 或网站 worker。执行前只读验证源版本，缺失库或旧合集 schema 明确失败，不创建／迁移数据库。

执行同时取得运行目录和实际源目录的原子锁，按固定顺序取得、逆序释放，不偷锁，也不占用内容 publisher 的锁。每次采集写入和发送前重读固定配置摘要；清单改变暂停，重新计划后再运行。开发工作树与运行 release 分开；下列命令仍是人工入口，不代表定时任务已安装。

```sh
node scripts/social-sync/refresh-cli.ts plan /ABSOLUTE/PRIVATE/social-refresh
node scripts/social-sync/execute-cli.ts run /ABSOLUTE/PRIVATE/social-refresh bilibili 20
node scripts/social-sync/execute-cli.ts upload /ABSOLUTE/PRIVATE/social-refresh bilibili 20
node scripts/social-sync/execute-cli.ts prepare-xhs /ABSOLUTE/PRIVATE/social-refresh 20
node scripts/social-sync/execute-cli.ts run /ABSOLUTE/PRIVATE/social-refresh xiaohongshu 20
```

`run` 优先补送已采到且未到刷新时点的 pending，无需重抓；到期样本重新采集，替换旧 pending。`upload` 只补送固定范围 pending，仍核对原 SHA、类型／成员版本和二十四小时发送边界，旧样本不能假改时间重试。按目标主键读取 outbox，不受旧批量接口的一百项窗口影响，也不发送其他目标。

SQLite 原子源／outbox 事务是断点。收到键及 SHA 都匹配的真实回执才确认；断网、取消、回执丢失保留 pending，相同负载通过原云 ingest 幂等重试。并发较新快照不能被旧回执确认。`latest-execution.json` 原子记录本次处理数量、真实采样时间、各项状态及摘要；`last-successful-batch.json` 只记录已成功批次，不代表整份目录完成。标准输出只有数量／状态，个人身份、地址和候选留私有文件。

## 小红书投影与待审核

`prepare-xhs` 只为到期且未待审的笔记生成 `browser-capture.json`，不接管浏览器。使用既有登录浏览器打开真实已核对的分享地址，运行生成的窄字段只读片段，保存 `xiaohongshu-snapshot.json`，格式为 `{version:1,snapshots:[投影或 UTF-8 base64]}`。片段支持平台 discovery/item 与 explore 路径，严格核对当前笔记及作者；输出身份、标题、类型、计数、已知日期及第一封面地址，不遍历评论正文或导出 Cookie。

导入前完整验证文件，最多二十条、捕获时间最多五分钟；随后按本次限额处理。手工提供的新鲜投影可提前更新统计，自动浏览器计划仍采用二十四小时周期。没有输入则报告 `waitingBrowser` 并保留旧数字／采样时间；不使用旧快照假装捕获成功，不自动解决登录／验证码。当前 CLI 尚未内置周期浏览器驱动。

合集成员／分 P 完整性、笔记类型和作品关联变化，在写原源库或调用云端前保存 `review-类型-键.json`；不自动改审核清单或云端批准。当前清单仍不允许该候选时，后续执行跳过它，避免重复采集。复核后的固定配置和数据库批准须分别落实，不能拿新样本自动重写成员签名。未知目标的浏览器输入拒绝；本执行器不扫描账号发现新作品，未来目录发现另项接待审流程。

## 失败与周期接入

验证、重定向、限流、格式缺失、字节预算或上传错误暂停当前批次；其他连续三次来源错误也暂停。采集失败不覆盖成功源，上传失败不确认队列。报告中待审／等待浏览器和失败是不同字段；非零退出需要查看私有报告，不自动循环重试或把所有非零都当成平台验证。

周期调度复用现有 Mac mini 调度器，尚未安装。B 站六小时、小红书二十四小时是**每份固定清单的刷新周期**，不能只在每个周期调用一次二十项入口。后续调度须在一个有总批次／时长上限的周期内顺序排空到期批次，已成功项由实际采样时间排除；遇 paused／cancelled／上传失败就停止，待审目标保留并通知。小红书还需浏览器投影驱动，按批捕获后及时提交。

已审核卡片及最后数字长期保留的独立实现见 PR173（旧库 PR #173，记录保留私有）。源刷新不续接旧 trial 资格、重新核对分享地址、启用网站模式或部署，也不批准新目标／成员。该投影已用三项真实更新回读，本轮工程与局限见[进度](progress/2026-10-13-social-bounded-refresh-executor.md)。
