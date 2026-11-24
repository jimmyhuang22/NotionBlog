# 2026-11-25：发布 #522 游戏页线上复验（Claude）

编辑登记：只新增本记录。发布 #522（main `339a9e3`）由 Codex 部署两站后，Claude 在正式站点只读复验游戏页。

## 怎么看的

无界面 Chrome，正式站点（本机线路，经新加坡），宽度 1440、390，默认外观深色。接口直接读取。

## 结果

- 接口：`/api/library/game/years?status=completed` 带 `platforms`（Switch 20、PlayStation 9、Steam 13、PC 5）和 `platformTotal` 42；带 `platform=playstation` 时年份只剩 2023（4）、2022（3）、2018（2）；`/api/content/game?status=completed&platform=switch` 共 20 款。PlayStation 比预览少一款，是 #519 改正了一款游戏的平台，年份统计同步。
- 页面：标题右边空着，没有排序按钮；大幕显示异度神剑2、“昨天”、234 小时，点第三只小盒子换成守望先锋2，底色跟着变；状态标签“通关”选中；平台一排款数和接口一致。
- 点 PlayStation：地址变成 `?platform=playstation`，列表 9 款、三个年份；再点“在玩”，平台保留，地址 `?status=playing&platform=playstation`，平台款数换成在玩的（全部 168、Switch 89、PlayStation 46、Steam 46，在玩里没有 PC），列表 46 款。整个过程是站内切换，只有两次整页载入（两个宽度各一次）。
- 往下滚：浮动坞出现，电脑上带状态和平台，手机上只有平台图标，和右下角的回到顶部按钮不重叠。
- 两个宽度都没有横向溢出、没有脚本错误。

## 没看的

- 上海线路（需要大陆网络）。
- 苹果、千禧外观，浅色主题。
