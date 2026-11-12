# 2026-11-13：切换与轻记录的修正（Claude）

编辑登记：Claude 修改 `src/components/page-switch.tsx`、`page-loading.tsx`、`scrolling-segments.tsx`（新增 `Segments`）、`status-feed.tsx`、`status-timeline.tsx`、`home-timeline.tsx`、`home-works.tsx`，`src/app/status/page.tsx`、`src/app/library/[type]/page.tsx`，`src/app/globals.css`、`library.css`、`motion.css`、`skins.css`、`timeline.css`，`src/lib/timeline.ts`（删除 `joinGames`）；删除 `tests/design-review-5-layout.test.ts`（只测 `joinGames`）；新增决策 `docs/decisions/2026-11-13-motion-repair.md`，在 2026-11-12 三处版面的决策里写明被取代的一条，更新 `docs/FRONTEND_GUIDE.md`。契约、接口与媒体路由、取数层、fixtures、依赖、栏目开关与后端代码未改。

## 来由

用户反馈四处（见决策）。先在正式站点只读录屏确认：

- 动态 → 学习、学习 → 作品（390 与 1440）：点击后约 140 毫秒出现灰色横线或灰色卡片，约 350–650 毫秒被真内容整块替掉；手机上学习页在两者之间还有一帧空白。这就是“长方形的视觉暂留”。
- 动态页换年份（390）：列表先变暗约 300 毫秒，列表到达后被按的“2026”消失两帧，选中块带着“全部”两个字滑过去，列表从 45% 直接跳回 100%。
- 首页：两款游戏被并成“这几天在玩 A、B”，平台与时长没有了。

## 改了什么

- **栏目占位**：`.page-loading` 里标题与搜索框以外的部分 0.32 秒后淡入（`--waited` 是已经等了多久：过渡画面显示时写在自己身上，路由提交时写在 `#main` 上，所以接手的加载画面接着同一个计时）。通用横线包进 `.page-loading__bars`，以免盖掉横线自己的呼吸。
- **显影**：`page-switch.tsx` 的 `arrive`：过渡画面显示过、目标不是首页时，等真实页面区没有加载画面后，把 `.wrap` 里标题以外的直接子元素 0.22 秒淡入。
- **选中块**：`Segments` 画一块 `.segmented__pill`，点击时（普通左键、非当前项）立刻滑到被按的链接并给它 `data-picked`；页面到达后按 `aria-current` 归位；8 秒没到则滑回。年份行是它的 `scroll` 形态，作品库的状态切换也改用它。四套主题各有选中块的样子。筛选链接不再带 `transitionTypes`，`segment-year`／`segment-status` 两个视图过渡名删除。
- **动态页换年份**：`StatusFeed` 用 `useFilterArrival`，前六条 `.entry.is-arriving` 的子元素升起。
- **首页**：`GamesLine` 与 `joinGames` 删除，每款游戏一条 `GameLine`。`HomeWorkLine` 的更新说明移到标题旁（`.work-line__head`、`.work-line__update` 小标），缩略图 48 高（横 85、竖 36）。

## 怎么验证的

- Node 24.21.0：`npm run check` 通过，3401 个测试通过，0 失败、0 跳过（含构建与隐私检查）。
- 本机正式构建，演示数据，无头 Chrome 录屏，1x：
  - 学习 → 动态，1440，每个请求加 250 毫秒：129 毫秒出现“动态”标题，其下为空；约 480 毫秒起轮廓淡入；内容到达后在标题下淡入，标题不动。作品 → 动态，390，每个请求加 100 毫秒：标题之后直接是内容，全程没有灰块。
  - 动态页换年份，1440 与 390：点击后第一帧选中块已在被按的年份上、名字已换；列表变暗后新条目升起，竖线与圆点不动。
  - 首页两种行：把正式站点首页接口的一页结果（只读取一次，存在会话临时目录，不入库）喂给一个不提交的预览页，1440 深浅两色：作品行“新增 1 个视频”在标题旁，两款游戏各一行、带平台与时长。
- 作品库（影视、书籍、游戏）的状态切换在本机不开放，没有在页面上按过；它与年份行是同一个组件。

## 限制与下一项

- 只在演示数据与无头 Chrome 下验证；正式站点上的时间要发布后再录一次对比。
- 岛屿、千禧、苹果下的选中块只核对了样式规则，没有逐套录屏。
- 下一项：岛屿的圆体中文字体、苹果自己的零件（用户 2026-11-13 同意），以及其余动效的复查。
