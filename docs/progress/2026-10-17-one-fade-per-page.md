# 2026-10-17：换页只淡一次，首页加载占位与首页同形（Claude）

编辑登记：Claude 本轮修改 `src/components/page-transition.tsx`、`src/app/motion.css`、`src/app/page.tsx`、`src/app/loading.tsx`、`src/app/timeline.css`、`src/app/library/[type]/page.tsx`、`src/app/status/page.tsx`、`src/components/filter-menu.tsx`，新增 `src/components/home-hero.tsx`、`src/components/page-loading.tsx`、`src/lib/transitions.ts` 与七个栏目的 `loading.tsx`（about、blog、library、photos、projects、search、status），以及前端接手说明。`PageTransition` 挂在根布局里，属全局入口；本项是反馈审查交接包 F18 列出的前端任务。契约、接口与媒体路由、fixtures、依赖、栏目开关与后端代码未改。

来由：反馈 F18，用户说点首页后“画面会加载好几下，组件也会移动好几下”。反馈审查对话逐帧录到一次点击整页淡四次，原因是页面区域的视图过渡对页面里任何内容到达都生效，首页又有两块分开到达的内容；加载占位是全站通用的几条横杠，和首页不同形。

## 改了什么

- `PageTransition`：按页面加 `key`，换页是一次退出加一次进入（类名仍是 `page`）；同一页里的更新默认不做过渡，只有带“filter”类型的导航（筛选链接）做，且只让选中块滑动。课程下的笔记算同一页，换笔记时目录和正文不淡。访客第一次操作之前不做任何过渡的规则不变。
- 筛选链接（作品库状态、年份、排序与排序菜单，动态年份）带 `transitionTypes`。
- 首页的开头抽成 `HomeHero`，页面与根加载占位共用；根加载占位只给首页用，其他栏目各有一个通用占位，够高，页脚不先露出来。首页时间线的占位最少 60% 屏高。

## 怎么验证的

只在演示数据下验证：本机生产构建（`CONTENT_PROVIDER=mock`，作品库栏目打开），无界面 Chrome，用真实鼠标点击，记录 `document.startViewTransition` 的调用和布局偏移。

- 为了重现“分批到达”，临时让首页时间线晚 1.5 秒、“关于”入口晚 0.7 秒（未提交）：**旧版从动态、影视、学习点站名回首页，每次 4 次过渡（约 0、0.43、0.85、1.53 秒）；新版每次 1 次。**
- 正式代码，1280 与 390：从动态、影视、学习点回首页，首页点“全部动态”，动态选年份，影视选“看过”，各 1 次过渡；同一门课里点“下一篇”0 次；点击后 3 秒布局偏移 0；每个起始页首次加载 0 次过渡、没有控制台错误。
- 检查与构建见合并请求说明。

## 限制

- 演示数据下验证；真实页面的逐帧复验由反馈审查对话在发布后做。
- 作品页与学习首页原有的专用占位没有改：作品页占位是清单的样子，作品封面在正式站点启用后（F16）需要改成卡片的样子。
- 只看了墨水浅色；偏好减少动态效果时 `motion.css` 本来就不播放 `page`，`filter` 类也不播放。
