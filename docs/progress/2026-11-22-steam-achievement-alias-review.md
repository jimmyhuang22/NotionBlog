# 2026-11-22：Steam 成就名称与版本复核（Codex）

按用户要求重新核对[前次发布](2026-11-22-steam-achievement-library-production.md)留下的 101 款。新加坡和上海的已发布目录各有 317 个游戏条目，快照一致。逐款对照 Steam AppID、作品译名、旧名、发行平台与版本，找到 101 个一对一对应的条目。重新查询前应用当前固定允许名单、隐藏、私人及配置排除项。101 款的 Steam 个人成就状态均可读，定义共 6,928 项。

《侠盗猎车手5》传承版和增强版、《精灵与森林》原版和最终版、《位霸 XL》和《超级位霸 XL》分别对应独立条目。对游戏名采用不同版本标识的平台，核对发行商的作品资料与站内实际版本。《古墓丽影》的 Steam 年度版由发行商的作品页直接链接，现有站内 PS4 奖杯继续独立显示。《变种基因》的新旧名称由开发者在 Steam 公告确认。[Rockstar 的版本说明](https://www.rockstargames.com/newswire/article/7551a7k917554a/free-upgrade-for-grand-theft-auto-v-on-pc-now-available) · [《古墓丽影》作品页](https://www.tombraider.com/products/games/tomb-raider-definitive-edition) · [Steam 更名公告](https://store.steampowered.com/news/posts/?appgroupname=Geneshift%3A+Battle+Royale+Turbo&appids=308600&enddate=1759503138&feed=steam_community_announcements)

补录沿用 [#447](https://github.com/jimmyhuang22/NotionBlog/pull/447) 已发布的数据接口和当前现役应用。新加坡每批导入时复核允许名单与发布目录，验收公开 HTTPS 明细后通过既有私有链路同步到上海。上海以同批压缩包的摘要、已发布条目和事务提交前的全量指纹核对数据。逐款依据和实际回执存于忽略目录。

19 批全部验收，两站均新增 101 套、6,928 项 Steam 成就，累计各有 149 套、10,255 项、788 个解锁日期和 8,276 枚图标。最终数据指纹一致。新增套组的正式 HTTPS 明细逐项验证通过，两站各抽查了 99 枚可用原图。另有 199 项可见成就的图标缺失或未通过校验，页面显示占位。1,147 项尚未解锁的隐藏成就保留隐去明细的占位。两站原有 47 套、2,808 项 PSN 奖杯也通过读回核验。

用户批准本轮最多使用 200 MB。有效压缩包合计约 28.23 MB，两站正式 HTTPS 验收读回的响应体累计约 17.67 MB。直传连接反复中断后，后八批沿用既有私有 COS 签名通道交付。遇到锁占用或回执中断时先只读核对现役库，再从已校验的批次继续。流量计入采集、传输和验收后仍低于批准额度。验收后按指纹核实并清理了上海的 19 个本轮临时传输包。

后续内容交付可用本轮 149 个 Steam 套组与既有 PSN 套组作为验收基线。
