# 2026-10-20：第二轮动效落地（Claude）

编辑登记：Claude 本轮修改 `src/components/reading-outline.tsx`、`src/components/use-filter-arrival.ts`（新增）、`src/components/library-grid.tsx`、`src/components/search-results.tsx`、`src/components/study-overview.tsx`、`src/components/course-tree.tsx`、`src/components/sort-toggle.tsx`（改为客户端组件）、`src/app/motion.css`、`src/app/study.css`、`src/app/library.css`、`src/app/globals.css`，新增决策记录。契约、接口与媒体路由、fixtures、依赖、栏目开关、全局入口与后端代码未改。

决定见[决策记录](../decisions/2026-10-20-quiet-motion-round-two.md)。

## 改了什么

- 目录：在 `ul.reading-outline` 里加一个 `reading-outline__mark`，按当前链接的 `offsetTop` 和高度摆放；第一次摆放不带过渡，摆好后当前链接不再画自己的左边线。点目录时给目标 `.prose__h` 加上 `is-arrived`，动画结束后自动移除。
- 进场：`useFilterArrival()` 在渲染时判断，同一路径下是否还有一个旧列表挂着，或者旧列表是否在 1.5 秒内刚卸下。是的话，列表把前 12 项标成 `is-arriving`，并写入序号 `--i`。影视、书籍、游戏和搜索用这个判断；课程页的切换由组件自己发起，所以直接计数。
- 课程页：分段控件里加 `study-views__pill`，苹果、千禧另有样式；旧列表复制一份后淡出。
- 目录树：展开时先显示再从 0 高度长出；收起时先收回再隐藏，`aria-expanded` 在按下时就改变，箭头随之转动。
- 骨架：`.skeleton` 的底色改为 `color-mix(in srgb, var(--ink) 7%, var(--bg))`，动画改为 `breathe 2.4s`（透明度 0.55 到 0.9）。`pulse` 保留给看大图的状态文字。
- 排序：`SortToggle` 改为客户端组件。点下时复制旧名称叠在原处淡出，箭头转 180°；新名称同时转进来。页面换好时，如果离点下还不到 0.22 秒，就从已有进度继续。4 秒后自动复原，防止导航失败时卡住。

## 怎么验证的

本机 `next start`（演示数据），无头 Chrome 1x，用真实鼠标点击：

- 课程页：首次打开没有进场标记；点“笔记”后旧列表在淡出，新条目带 `arrive-row`，底块停在被点的按钮下（左边距 296 / 296）。
- 影视：首次打开 0 条进场；切到 2026 年后 7 条进场；从页头点进书籍时 0 条。搜索切换分类后 12 条进场。
- 排序：点下后旧名称的复制层出现，按钮上有 4 段动画；结束后复制层移除，按钮显示“最早”，地址带上 `order=date-asc`。
- 目录树（抽屉里，带坐标的点击）：收起和展开都有高度与箭头动画，抽屉保持打开。
- 骨架：`breathe 2.4s`。
- 减少动态效果：所有项目都没有动画，骨架不动，功能照常。控制台没有错误。
- 类型检查、样式测试、构建通过；完整检查见合并请求。

## 限制与下一项

- 演示数据的笔记只有一个目录项，所以目录墨线的滑动和标题闪线只验证了“已摆放”；真实长笔记要发布后在正式站看。
- 筛选进场的判断依赖新旧列表同时存在，或旧列表刚刚卸下。如果某次导航先显示了整页加载态，超过 1.5 秒才出新列表，就不会播放进场，直接显示。
