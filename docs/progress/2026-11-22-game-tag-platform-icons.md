# 2026-11-22：首页游戏标签带平台图标（F60，Claude）

编辑登记：Claude 新增 `src/components/game-tag.tsx`，修改 `src/components/home-timeline.tsx`、`src/lib/library.ts`（`platformChip` 认出 Switch 2，新增 `gamePlatformIcon`）、`src/app/timeline.css`，补 `tests/library.test.ts`、`tests/reading-design-refinement.test.ts`；文档改 `docs/FRONTEND_GUIDE.md`，新增决策 [2026-11-22-game-tag-platform-icons](../decisions/2026-11-22-game-tag-platform-icons.md)，并在 2026-11-19 的首页游戏决策里加一句指向它。没有改接口、契约、fixtures、依赖和栏目开关。

## 页面与组件

- 首页时间线游戏那一行的标签：认得的平台名前有 13 像素单色图标，和标签文字同色；Steam、PlayStation、Switch、3DS 用 Simple Icons 原图形，PC 是显示器，Switch 2 用 Switch 的图标。认不出的平台只写名字。图标对读屏隐藏。
- `GameTag` 从 `home-timeline.tsx` 移到自己的文件，接收平台短名；标签里是一整段行内文字，所以“在”和“上玩”两边的空格还在，每个平台的图标和名字是一个不会断开的块。
- `platformChip("Nintendo Switch 2")` 现在是“Switch 2”（原来原样显示长名字），游戏卡和详情的平台块也跟着变短，颜色同 Switch。

## 验证

- 单元测试：平台与图标的对应（含小写 steam、PS5、New 3DS、Switch 2、Xbox、演示平台）；渲染标签核对去掉图标后的文字与改前相同（“在 Steam 上玩”“在 Steam、PlayStation 上玩”“在玩”），图标带 `aria-hidden`、填 `currentColor`，认不出的平台不出图标。
- 本机构建的演示站点不开游戏栏目，首页没有游戏行，所以这一轮临时加了一个预览页（未提交）：把线上首页接口 2026-11-22 的前 40 条真实数据交给 `HomeTimeline`，其中六款游戏的平台是 Steam、Steam · PlayStation、Nintendo Switch 2、Nintendo Switch · Nintendo Switch 2；另加五条演示行（3DS、PC、Xbox、三个平台、没有平台），只在预览里出现。
- 截图：墨水、岛屿、苹果、千禧四套外观，浅色 1280 / 390、深色 1280，另看墨水 320、岛屿深色 320、千禧放大三倍。图标颜色和标签文字一致、边缘清楚；高度和改前的标签一样（23 像素）；320 宽时“在 Steam、PlayStation 上玩”整体换到下一行；都没有横向滚动。
- `npm run check`、`npm run build` 见合并请求。

## 限制

- 3DS、PC、Xbox 和三个平台的样子只在演示行里看过，线上现在没有这些游戏。
- 正式路由的首页没看过（本机构建关着游戏栏目），等发布后在线上复验。
- 标签写哪些平台仍是游戏记下的全部平台；F59（只写最近一次游玩的平台）等 Codex 补数据。

## 下一项

- 随下次发布复验：首页守望先锋 2、杀戮尖塔 2 带 Steam 图标，最终幻想 7（Switch 2）和异度神剑 2 的 Switch 图标，四套外观、两种宽度；通过后关闭 F60。
