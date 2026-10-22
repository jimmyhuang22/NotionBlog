# 2026-10-20：设计自检第一批落地（Claude）

编辑登记：Claude 本轮修改 `src/app/timeline.css`、`src/app/globals.css`、`src/app/library.css`、`src/app/study.css`、`src/app/skins.css`、`src/components/study-overview.tsx`、`src/lib/study-overview.ts`、`tests/study-project-ui.test.ts`，新增决策记录。契约、接口与媒体路由、fixtures、依赖、栏目开关、全局入口与后端代码未改。

决定见[决策记录](../decisions/2026-10-20-design-review-batch-one.md)。

## 改了什么

- 动态卡片标题：`font-weight: 400` 加 `-webkit-text-stroke: var(--title-stroke, 0.35px) currentColor`；只有标题的短卡不描边；苹果、千禧在各自的变量块里把 `--title-stroke` 设为 0。
- 手机（≤ 540）`.page-head` 留白 10／14、标题 `--text-3xl`；`.library__filters` 外边距 -2／8，年份标题 `--text-lg`；`.crumbs` 上下 10／8。
- 手机（≤ 540）影视与书籍详情用两列网格：`.work__info` 设 `display: contents`，封面占第一列 5 行，属性表及其后的元素跨两列；游戏详情不变。
- 课程纵览：视图名中文化；`.study-views` 加上 `.segmented`，分段控件的规则从链接扩到 `button[aria-pressed]`（全局、苹果、千禧同步）；类型标记与读屏名称来自 `studyTypeLabels`；日期由新的 `studyDateText` 生成，测试覆盖同月、跨月、跨年、单日、同日时段。类型列宽 114／108 → 26。
- 笔记页“课程目录”：`.tree__icon` 改为 `--muted`，作业与 eFolio 用 `--accent`；四种类型的颜色变量随之删除（再无引用）。原型在正式站 样本课程 C 目录上拍过现状／甲／乙。
- 游戏格子：容器宽 ≤ 210 时评分 `justify-self: start`。

## 怎么验证的

- 原型阶段：正式站真实内容（动态、游戏、样本电影详情、样本课程 C 课程页）注入样式拍前后对照，每页访问一次。手机首屏第一张动态卡片 398 → 316，游戏第一行封面 342 → 276，详情片名 542 → 146、属性表 710 → 378（390×844）。
- 实现之后：`next dev` 的开发隔离会把栏目开关清空，看不到影视、书籍、游戏，所以用 `npm run build` 加 `next start`（演示数据、全部栏目开）检查，无头 Chrome，1x。
  - 390 宽：墨水动态首张卡片 294；游戏评分左边与格子左边对齐；影视详情片名 146、属性表 378；书籍详情片名 146；课程页无横向溢出。
  - 卡片标题计算值：墨水与手帐 400＋0.35px 描边，苹果 600、千禧 700 且描边 0。
  - 课程页 1440 宽：墨水、千禧、深色下标签为“总览／笔记／周课／作业”，日期“8 月 17 日”，类型圈在各主题下可读。
- `npm run typecheck`、`tests/study-project-ui.test.ts`、`tests/style-scale.test.ts` 通过；`npm run build` 通过。

## 限制与下一项

- 实现后只在演示数据下验证过；演示课程没有作业条目，实心墨点“作”和跨月、跨年日期只在原型（正式站真实内容）与单元测试里看过。真实课程、真实海报的效果要发布后在正式站复看。
- 正式站数据里“Assignment 2 - 35%”的类型是笔记，所以目录与课程页都显示为笔记；需要在 Notion 里改类型。
- 手机课程页到目录前仍要滑几屏（R-05），作品详情变短后页脚上移（W-02），留给下一批：游戏格子信号（H-02）、作品详情一句话（H-04、W-02）、时间线画线入场（M-03）、控件对齐（X-01、X-02、M-01）。


隐私整理：本文的个人站点地址、课程代号及笔记定位按需泛化；原样本与回执保留在私有记录，技术测量和当时验收结论不变。
