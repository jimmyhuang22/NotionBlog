# 固定范围社交刷新

用户已选择 B 站每六小时、小红书每二十四小时。目标固定为已确认作品和合集；新作品、新成员、作品重新关联与笔记类型变化仍待审，不自动扩展公开范围。离线计划命令只读；人工有界执行器已接既有采集／队列／受限上传并通过三项真实更新，具体行为见 [执行器说明](SOCIAL_REFRESH_EXECUTOR.md)。周期浏览器驱动与调度保持未安装。

## 计划入口

在外置 SSD 创建一个独立 700 私有目录，准备 600 的 `refresh-config.json`，格式见 [虚构示例](../scripts/social-sync/templates/refresh-config.example.json)。`stateDirectories` 指向原有发布及合集的私有状态目录，不搬迁或复制数据库。两类目标合计最多五百，输入上限 512KiB；作者／发布／合集身份、作品关联和类型须来自人工确认清单。

```sh
node scripts/social-sync/refresh-cli.ts plan /ABSOLUTE/PRIVATE/social-refresh
```

只读打开既有 SQLite，不创建源数据库或迁移。每项采用最后成功观测的 `observedAt`，分别加六／二十四小时计算 `nextDueAt`；失败尝试、计划时间、上传时间及链接检查时间都不刷新采样时刻。缺少某项观测则需采集，缺少整个状态库或损坏数据则明确失败；未来超过三十秒的证据拒绝。

原子写入同目录 `refresh-plan.json`，包括固定范围摘要、每项状态／观测与负载摘要及最多二十目标的批次配置。`due` 是到期，`fresh` 是本地采样未到刷新时点，`review-required` 是现有候选身份或成员已变；fresh 不证明已上传、链接可用或网站批准。小红书批次显式为 `xiaohongshu-browser`，不是 HTTP 抓取或已完成浏览器采集。标准输出只含数量与状态，个人地址／身份留在私有计划中。

## 发送前守卫

刷新执行器应包裹原有传输，再交给原 outbox 发送流程：

```ts
const sendPublication = reviewedPublicationSender(rawRefreshConfig, restrictedPublicationSend);
const sendCollection = reviewedCollectionSender(rawRefreshConfig, restrictedCollectionSend);
```

守卫核对当前待传项的真实身份、作品关联／类型、原始 SHA 和采样新鲜度，在实际调用传输前拒绝异常。没有 SQL、登记、审批或上传确认；仍由原传输核对受限登录、服务器绑定、负载和回执，原队列按键＋SHA 确认。旧的普通 upload 命令保持原行为，不能把它当作已经安装了常态刷新守卫的执行器。

合集的 `collections` 项为 `{target, memberShas}`。`memberShas` 只能从已经审查的固定成员版本清单生成；签名与服务器 `collection_member_digest` 一致，包含 BV、排序后的 CID 集合及 `partsComplete`，不含统计、标题或日期。可用 `collectionMemberShas(reviewedSnapshot)` 计算已审核快照的签名；不能拿新采样自动重写审核清单。

统计或成员日期变化可通过；新增／移除 BV、分 P 集合改变及完整性状态改变均需审核，代表视频变更也需重新核对。该合集不进入自动采集批次，发送守卫不调用云传输，不把新状态覆盖到服务器。原本地采样和待传保留，复核后更新固定清单再生成计划；不会生成多张合集卡或以集数差值猜新增。保留云上旧快照并不延长其已有有效期。

## 待启用的配置草案

| 任务 | 频率 | 来源 | 失败行为 |
| --- | --- | --- | --- |
| B 站发布和合集 | 每六小时 | 已确认目标的公开视频页面 | 平台限制、身份不符或不完整时保留上次成功采样，停止该目标，不续接资格 |
| 小红书笔记 | 每二十四小时 | 已登录浏览器的新鲜投影 | 登录／验证码／访问受限时暂停，要求人工处理；不导出 Cookie 或自动解决验证码 |
| 展示范围 | 独立逐项审批 | 已审核身份／类型／成员投影 | 现有 worker 无审批权，不让采集成功自动批准来源 |

配置草案在私有运行目录，调度保持关闭。后续复用现有 Mac mini 调度器的一次性任务，不增加守护进程、端口或 SQLite 数据库服务；保持开发与冻结 release 分开。当前这份计划 CLI 不能直接替代采集／浏览器／上传执行器。

旧 trial reader 仍要求来源采样与临时资格在二十四小时边界内，每日刷新加耗时或失败可能空窗。用户已另外确认保留长期已审核卡片及最后真实数字、标注采样时间，独立实现见 PR173（旧库 PR #173，记录保留私有）。本计划／执行器不改旧 RLS、TTL 或角色，不伪造分享地址检查；网站模式与页面标签另接。手工执行成功不等于六／二十四小时调度已经运行，完整周期须按执行器说明顺序排空有界批次。封面、抖音和自动发现另项。
