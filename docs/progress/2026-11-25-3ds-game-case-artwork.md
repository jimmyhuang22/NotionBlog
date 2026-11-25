# 2026-11-25：3DS 日版卡盒共用比例与封面验收（Codex）

共用卡盒比例和游戏墙统一取 1.091。没有独立取景窗口的 3DS 盒图按正方形计算保留像素，近方形横图可以进入该分支，至少保留 560 像素。其他平台沿用原有尺寸规则。明确标注为日版实体盒的图面继续使用现有 `boxArtLayout.mode=retail` 和原图像素窗口。Notion 映射、网站 DTO、已发布库结构和前端样式沿用现有接口。[3DS 卡盒决定](../decisions/2026-11-25-game-case-3ds.md) · [封面展示字段](../decisions/2026-11-24-game-cover-layout.md)

六份图面在本机核对了原图宽高、窗口边界、Notion 映射和 560 像素门槛。《火焰之纹章 if》按用户确认选白夜王国，《精灵宝可梦 究极之日／究极之月》选究极之日并排除图外下载版横幅。《时之笛 3D》使用日版原版 640 × 569 的正面，窗口为 `[1, 0, 568, 568]`。素材与发布清单保存在忽略目录。现役 Notion 和两站内容写入等待本批授权。[任天堂日版作品页](https://www.nintendo.co.jp/3ds/aqej/) · [时之笛 3D 日版封面来源](https://gamesdb.launchbox-app.com/games/images/12252-the-legend-of-zelda-ocarina-of-time-3d)

Node 24 离线 `npm run check` 的 3,567 项测试全通过，`npm run build` 通过，52 份服务端追踪通过隐私检查。回归覆盖 3DS 正方形和近方形、原图有效像素下限和日版实体盒窗口，页面层仍显示 1.091。
