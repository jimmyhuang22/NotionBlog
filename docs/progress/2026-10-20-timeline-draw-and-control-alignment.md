# 2026-10-20：首页时间线画线入场、作品页排序并入标题行、快捷搜索淡入（Claude）

编辑登记：Claude 本轮修改 `src/app/page.tsx`、`src/components/home-timeline.tsx`、`src/app/motion.css`、`src/app/works/page.tsx`、`src/components/works-shell.tsx`、`src/app/timeline.css`、`src/components/search-palette.tsx`，新增决策记录。契约、接口与媒体路由、fixtures、依赖、栏目开关、全局入口与后端代码未改。

决定见[决策记录](../decisions/2026-10-20-timeline-draw-and-control-alignment.md)。

## 改了什么

- 首页时间线入场：首页的时间线区块加上 `timeline--home`；`HomeTimeline` 给前 8 行的外层写入 `--i`（行序）。`motion.css` 的减少动态偏好块里，这几行的 `.timeline__month`／`.entry` 用 `clip-path` 从上往下揭开（每段 0.2 秒，第一段在 350 毫秒开始，之后每段间隔 150 毫秒），`.entry::before` 圆圈弹出，`.entry > *` 浮现。填充模式只用 `backwards`：动画结束后不留下任何裁切或位移，卡片阴影和手帐胶带不受影响。
- 作品页：`WorksShell` 把平台分段和 `SortToggle` 放进标题行的 `.works__tools`（`flex-wrap`，窄屏时整体落到标题下面）；切换平台、等待新列表时排序暂时隐藏。默认排序名称改为“最近”。
- 快捷搜索：`.palette[open]` 和背景加上与关于弹层相同的过渡与 `@starting-style`；关闭不做过渡。尚未输入时 `.palette__status` 加 `visually-hidden`。

## 怎么验证的

- 原型阶段：在正式站首页、作品页注入样式，逐帧定格拍摄（时间线 0–1400 毫秒、搜索 0–280 毫秒），每页访问一次。
- 实现之后：`npm run build` 加 `next start`（演示数据，全部栏目打开），无头 Chrome 1x 截图。
  - 首页 1440 宽，在墨水、手帐、千禧主题下取 400、600、800、2000 毫秒四帧：墨线依次画出，手帐画的是虚线；8 行都带有序号；结束后状态与原来一致。模拟“减少动态效果”时页面上没有任何动画（0 个）。
  - 作品页 1440 与 390 宽：排序在标题行，显示“最近”，无横向溢出。
  - 快捷搜索：透明度在 0 毫秒为 0、100 毫秒约 0.8、300 毫秒为 1；重复的提示句已对视觉隐藏。
- 类型检查与样式测试通过，`npm run build` 通过；完整检查结果见合并请求。

## 限制与下一项

- 实现后只在演示数据下验证过。正式站首页的时间线是流式加载的：如果晚于头像区出现，画线会从它出现那一刻开始，发布后要在正式站看一次真实节奏。
- Fable 出稿顺序里剩下的是第八项千禧主题字形（C-03），是否处理要看用户是否还在意这套主题；其余低优先级发现可合成一批。
