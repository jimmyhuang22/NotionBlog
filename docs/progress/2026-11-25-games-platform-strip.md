# 2026-11-25：游戏页接上平台筛选（Claude）

编辑登记：Claude 修改 `src/components/game-tools.tsx`（平台一排和浮动坞）、`src/app/library/[type]/page.tsx`（读 `?platform=`）、`src/components/library-grid.tsx`（翻页带平台，选了平台时年份不写各平台几款）、`src/components/section-waiting.tsx`（加载形状加平台一排）、`src/lib/library.ts`（`libraryHref` 加平台，新增 `gamePlatformCategories`、`readGamePlatform`）、`src/app/library.css`，更新 `docs/FRONTEND_GUIDE.md` 和 [年轮决策](../decisions/2026-11-24-games-rings.md)。契约和后端是 Codex 的 #520（[记录](2026-11-25-game-platform-filters.md)）。

## 做了什么

- 状态标签右边是平台：全部、Switch、PlayStation、Steam、PC，每个带款数，浮起的分段，深色块滑到选中的那个。款数只按状态统计；没有游戏的平台不显示；回应里没有平台统计时整排不画。
- 地址：`?platform=switch|playstation|steam|pc`；换状态时平台保留，换平台时年份清掉；列表翻页也带平台。
- 底部浮动坞带着状态和平台，手机上只放平台图标。
- 选了一个平台时，年份下面不再写各平台几款。

## 怎么验证的

- 本机正式构建加未提交的预览页：线上全部 317 款存成 JSON，按 #520 的平台匹配规则在预览里筛选和统计。1440、390：通关下全部 42、Switch 20、PlayStation 10、Steam 13、PC 5；选 PlayStation 后剩 2024、2023、2022、2018 四年共 10 款；再切到想玩，平台保留，只剩 4 款，想玩下没有 PC。深色块和选中项对齐，浮动坞出现，没有横向溢出，没有脚本错误。
- Node 24 下 `npm run check` 与 `npm run build`，结果见合并请求。

## 限制与下一项

- 只在预览里模拟了后端，正式数据库读取路径在发布后复验。
- 随发布在上海、新加坡复看各状态、各平台的款数和年份。
