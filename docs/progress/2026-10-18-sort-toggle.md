# 2026-10-18：排序切换按钮与只给键盘的焦点框（Claude，F34）

编辑登记：Claude 本轮新增 `src/components/sort-toggle.tsx`、`src/lib/input-mode.ts`，修改 `src/app/library/[type]/page.tsx`、`src/app/works/page.tsx`、`src/lib/library.ts`、`src/lib/game-dates.ts`（删去不再用的 `hasPlatformDates`）、`src/app/layout.tsx`（头部脚本多一段）、`src/app/globals.css`、`src/app/library.css`、`src/app/skins.css`，删除 `src/components/filter-menu.tsx`。契约、接口与媒体路由、fixtures、依赖、栏目开关与后端代码未改。

决定见[决策记录](../decisions/2026-10-18-sort-toggle-and-keyboard-focus.md)。

- 排序按钮：一个链接，写当前排序和图标；按下后在新列表到来前已经显示将要换成的排序（沿用 `link-pending`）；读屏名称“排序：最近，点按改为最早”。像素主题沿用左侧小箭头标记，不加底色。
- 焦点：头部脚本在根元素记录最近一次输入是键盘还是指针（`data-input`）。指针模式下不画焦点框（包括浏览器自带的那种），像素主题的悬停框与首页头像外圈也只在非指针模式下随焦点出现。文本框照常。

## 怎么验证的

本机开发服务器、演示数据（游戏、影视、书籍、作品均为演示内容），无头 Chrome：

- 宽度 1280、768、390、320：游戏在玩、通关、想玩、按最早，作品 B 站与小红书按点赞；按钮都在年份条同一行最右，与状态切换右边缘对齐（1132）；手机上年份条滑动、按钮不换行；没有横向溢出。
- 主题：墨水浅色、深色、苹果、像素、千禧各看影视或书籍一页。
- 按下“最近”：60 毫秒时按钮已写“最早”，到达后地址为 `order=date-asc`，读屏名称变为“排序：最早，点按改为最近”。
- 旧地址 `order=title-asc`：按“最近”打开，按钮指向 `order=date-asc`。
- 焦点：鼠标点击后无框；模拟浏览器恢复焦点（`focus({ focusVisible: true })`）在指针模式下无框；按 Tab 后框出现并跟随（站名 → 动态）。没有在真实浏览器里切换标签页看过，这一步用模拟代替。
- 控制台无错误。

## 限制与下一项

- 只在演示数据下看过；真实游戏页年份更多（到 2018），按设计应在年份条里滑动，发布后看一次。
- 作品页按钮的样子按交接要先给用户看，已附截图。
