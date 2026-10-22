# 2026-10-20：搜索结果、关于名片、海报书架、列表结尾（Claude）

编辑登记：Claude 本轮修改 `src/components/search-results.tsx`、`src/lib/search.ts`、`src/components/about-dialog.tsx`、`src/app/page.tsx`（只给关于弹层传入头像和名字）、`src/components/list-tail.tsx`、`src/components/home-timeline.tsx`、`src/components/status-feed.tsx`、`src/components/works-list.tsx`、`src/app/globals.css`、`src/app/library.css`、`src/app/skins.css`，新增决策记录。契约、接口与媒体路由、fixtures、依赖、栏目开关、全局入口与后端代码未改。

决定见[决策记录](../decisions/2026-10-20-optional-polish.md)。

## 改了什么

- 新增 `--pen-stroke`：把首页名字下那一笔做成遮罩变量。页头当前栏目、关于名片、列表结尾都用它。
- 搜索：结果链接去掉 `card`；栏目小圈 `.search-hit__kind`（来自 `kindMarks`，读屏读完整名称）；条目之间用细线隔开；摘要缩进与标题对齐（手机上不缩进）；`mark` 改成下半截的底色。
- 关于：`AboutDialog` 接收头像和名字，在标题上方显示 `Avatar`；样式为 460 宽的居中名片。
- 书架：`.library__cover::after` 向两侧各伸出半个间距，同一排连成一条线；只在墨水和手帐里出现。
- 列表结尾：`ListTail` 的结尾文字加上 `list-tail__end`；首页、动态、作品三处文案改为“到底了”。

## 怎么验证的

- 原型阶段：正式站真实内容（搜索“Notion”、首页关于弹层、影视、2025 年动态的结尾），1440 与 390 宽。拍摄时发现另一个会话也在用调试端口 9833，部分截图因此串成了手机宽，换到 9871 端口后全部重拍。
- 实现之后（`next start`，演示数据，1440 宽，墨水、手帐、苹果、千禧四套）：搜索 36 个小圈、没有卡片；关于名片宽 460，墨水的标题有笔划，其他三套没有；书架线墨水是实线、手帐是虚线、苹果和千禧没有；标题字体按主题切换。
- 类型检查、样式测试、构建通过；完整检查见合并请求。

## 限制与下一项

- 演示数据的列表不够长，看不到结尾的“到底了”；它沿用了原有组件，发布后在正式站 2025 年动态的结尾看。
- 关于名片里的正文目前是占位文字，正式内容填进去后再看一次排版。
