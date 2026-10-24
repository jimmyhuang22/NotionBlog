# 2026-10-24：前端审查后的代码整理（Claude）

编辑登记：
- 新增：
  - `src/components/platform-signs.tsx`
  - `src/components/use-dismiss.ts`
  - `src/lib/runs.ts`
  - `tests/runs.test.ts`
  - `tests/helpers/moment-text.ts`
- 修改：
  - 作品卡片：`social-work-card.tsx`、`bili-card.tsx`、`works-card.tsx`、`home-works.tsx`
  - 列表：`post-list.tsx`、`status-timeline.tsx`、`library-grid.tsx`
  - 弹窗与菜单：`lightbox.tsx`、`search-palette.tsx`、`about-dialog.tsx`、`theme-toggle.tsx`、`nav-links.tsx`
  - 显示逻辑：`src/lib/{works,library,home-feed,timeline,format}.ts`
  - 对应的测试
  - `docs/FRONTEND_GUIDE.md`

没有改契约、接口、依赖、栏目开关或样式。

接着 [#83](2026-10-24-frontend-review-minor.md)，做审查里剩下的整理。目标是行为和画面都不变：净减 130 多行，四处重复合成一处。

## 改了什么

- **平台作品卡片**：首页作品卡片、B 站卡片、作品页卡片、首页作品清单，原本各自复制了平台标志、播放/点赞/合集图标和“在某平台打开”的读屏文字。现在都从 `platform-signs.tsx` 取。
  - 作品页上小红书标志用的是方形画框，和别处不同，靠 `square` 参数保留了原样。
  - 合集的“共 N 个”以前是从“151 个视频”这样的文字里用正则抠数字。现在 `WorkLine` 带了一个数字字段 `count`（合集的 `memberCount`，或多 P 视频的 `partCount`），数量为 0 时照旧显示 0。
  - 顺带删掉了首页作品卡片里早已失效的 `late()` 包装，作品页卡片也不再重复调用 `workLines`。
- **分组**：新增 `runsBy`，把相邻的同组条目合在一起，不重新排序。博客、动态、作品库、作品页四处按年或按月分组都改用它。首页时间线的 `feedRuns` 规则不同（只把连续的作品串起来，其他条目各成一组，还要记录起始位置），没有套用。
- **弹窗与菜单**：
  - 三个弹窗（看大图、搜索、关于）共用 `useModal`（打开时调用 `showModal`）和 `closeOnBackdrop`（点背景关闭）。
  - 两个菜单（主题、更多）共用 `useMenuDismiss`（Esc 关闭并把焦点还给按钮、点外面关闭）和 `closeOnLeave`（焦点移出关闭）。
- **只剩测试在用的导出**：
  - 删掉在生产代码里没有调用路径的：`workYear`、`workDay`、`groupWorksByYear`、`daySpan`、`summaryLine`、`timeLabel`、`metricText`。另外，书籍卡片那行文字里永远走不到的电影和游戏分支也删了；其中游戏分支还会写出“0 小时”。`cardParts` 的类型收窄为不收游戏。
  - `momentText` 挪进测试辅助文件。
  - `figureText` 改为导出：它就是 `metricText` 包装的那个、页面实际在用的函数，测试直接测它。
  - `statusLabel` 和 `collectionUpdate` 在本文件内部有用，测试测的也是真实逻辑，保留导出。
  - 相关测试都改为测页面实际在用的函数，覆盖没有减少；时区跨年等用例换到 `workDayMoment` 和 `groupWorksByPublishedYear` 上。

## 怎么验证的

- **卡片输出前后逐字节一致**：用 Next 自带的 SWC 在本机渲染 4 个卡片组件的 64 种情况，改前改后的 HTML 完全相同。这些情况包括：有封面和无封面、单平台和双平台、合集、多 P、数量为 0、没有链接、没有数字、带“新增”、带年份、不带日期。
- `npm run check`：2591 个测试里 2563 个通过。失败的 28 个仍是本机 Node 26 跑不了的那 4 个后端文件，和改动无关。
- `npm run privacy:check` 和 `npm run build` 通过。
- 无界面 Chrome，1280 宽，演示数据，生产构建：
  - 主题菜单：Esc 关闭并把焦点还给按钮、点外面关闭、焦点移出关闭。
  - 搜索面板：按 `/` 打开、Esc 关闭、点背景关闭。
  - 看大图：点图片不关、点背景关闭、Esc 关闭。

## 限制

- 演示数据没有“关于”内容，导航栏也没有“更多”，这两处没有在浏览器里点过。它们用的是同一组共用函数，搜索面板和主题菜单已经验证通过。
- 列表分组的改动由类型检查和单元测试覆盖，没有逐页截图对比。

## 下一项

审查里还剩没做的：
- 引入 ESLint（尤其是 React Hooks 规则），属于依赖变更，要先问用户。
- 合并“普通左键点击”的判断、减少动态效果的判断、取数错误的映射这几处小重复，可以另找时间。
