# 2026-10-21：栏目切换与作品页排序切换（Claude）

编辑登记：Claude 本轮修改 `src/components/nav-links.tsx`、`src/components/use-filter-arrival.ts`、`src/components/works-list.tsx`、`src/app/globals.css`、`src/app/motion.css`，新增决策记录。契约、接口与媒体路由、fixtures、依赖、栏目开关、全局入口与后端代码未改。

决定见[决策记录](../decisions/2026-10-21-switch-motion.md)。

## 改了什么

- `NavLinks`：新增 `.site-nav__mark`，在 `useLayoutEffect` 里按 `usePathname()` 摆到当前栏目（或“更多”按钮）下方。因为与新页面在同一次提交里更新，页面的视图过渡会用 `view-transition-name: nav-mark` 把它从旧位置带到新位置。字体加载完成和窗口缩放时会重新摆放。摆好之后，各链接原来的 `::after` 笔划隐藏；首屏绘制前以及其他主题仍用原来的标记。
- 页头链接点击时，按栏目顺序在 `<html>` 上设置 `data-nav-dir="next|prev"`，1.2 秒后清除；`motion.css` 在有这个属性时用 `page-aside`／`page-along` 取代向上的淡入。
- `useFilterArrival(group)`：增加分组参数。作品列表按平台分组，所以同一平台换排序会播放进场，换平台不会（换平台由 F40 负责）。
- 作品列表的前 12 项带 `is-arriving` 和 `--i`。

## 怎么验证的

- 原型：正式站 /status 点到“学习”、作品页“最近 → 播放最多”，逐帧定格拍摄现状和两个方案。
- 实现之后（`next start`，演示数据，真实点击）：
  - 820、390、1440 宽的墨水主题：点“学习”后方向为 next；出现了 `nav-mark` 分组动画，以及 `page-aside`／`page-along`；结束后标记位于“学习”正下方（608/608、81/81、1221/1221）；方向属性已清除；无横向溢出。
  - 苹果、手帐：有方向动画，没有标记。减少动态效果：没有动画。
  - 作品页：首次打开 0 张进场；换排序后 12 张进场；换平台后 0 张，不重复。控制台没有错误。
- 类型检查、样式测试、构建通过；完整检查见合并请求。

## 限制

- 演示数据里没有“作品”栏目，墨线经过折叠菜单“更多”的情况只在 820 宽核对了位置；发布后在正式站来回点一遍。
