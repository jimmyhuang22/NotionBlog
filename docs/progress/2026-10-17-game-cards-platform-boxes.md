# 2026-10-17：游戏卡片——平台色块、白金角标、时长写法（Claude）

编辑登记：Claude 本轮修改 `src/lib/library.ts`（`platformChip`、`cardTimeLabel`、`gameCard`，`coverBadge` 加白金；顺手把 `summaryParts` 的注释放回它自己上面）、`src/components/library-grid.tsx`（`GameLine`）、`src/app/library.css`、`src/app/skins.css`、`tests/library.test.ts`，新增决策记录。契约、接口与媒体路由、fixtures、依赖、栏目开关、全局入口与后端代码未改。

决定见 [决策记录](../decisions/2026-10-17-game-cards-platform-boxes.md)。

## 怎么验证的

- 本机临时页面（已删除，未提交）：从正式站点读了一次游戏“通关”与“在玩”第一页（各 24 款；通关里 11 款白金），用正式的 `LibraryGrid` 渲染；截图时封面地址指向正式站点的 400 小图。
  - 1440、1280、768：评分与平台、时长同一行；390、320：评分在第三行靠右，每张卡都有这一行；白金是金色角标；PC 黑底、Switch 红底、PlayStation 蓝底；“1903 小时”“51.8 小时”；“在玩”里一款 0 小时不写时长。都没有横向溢出。
  - 墨水深色、苹果浅深、像素浅深、千禧：深色主题 PC 方框是浅灰蓝底；像素方角。
  - 中途修了两处：金色角标起初被后写的通用角标样式盖住；评分换行宽度起初设成 250，桌面 1280 的卡（约 232 宽）也被挤到第三行，改为 210。
- `tests/library.test.ts`：平台简称与色调、时长规则（整数／一位小数／0 与未知不写／分钟）、白金角标、无评分为空、多平台。类型检查、测试与两种构建见合并请求说明。
- 截图放在忽略的 `.local/theme-options/2026-10-17-game-cards/`。

## 限制

- 游戏详情页的平台与时长写法没有改（交接包要求改之前先问用户）。
- 214 款没有状态的游戏要等 Notion 补好并恢复同步后才进列表；17 款“想玩”带时长的照数据显示。
