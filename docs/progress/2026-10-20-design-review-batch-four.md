# 2026-10-20：设计自检第四批落地（Claude）

编辑登记：Claude 本轮修改 `src/components/month-label.tsx`（新增）、`src/components/home-timeline.tsx`、`src/components/status-timeline.tsx`、`src/components/search-results.tsx`、`src/components/search-palette.tsx`、`src/lib/search.ts`、`src/app/globals.css`、`src/app/timeline.css`、`src/app/library.css`、`src/app/study.css`、`src/app/skins.css`、`tests/search.test.ts`，新增决策记录。契约、接口与媒体路由、fixtures、依赖、栏目开关、全局入口与后端代码未改。

决定见[决策记录](../decisions/2026-10-20-design-review-batch-four.md)。

## 改了什么

- `MonthLabel` 用月份键（“年-月”）生成“十月”和年份两段；首页与动态页的时间线共用。日期未记录的分组仍显示原文字。
- 页头：只在墨水主题（`:root:not([data-skin])`）下，用遮罩画出与 `PenStroke` 同一路径的短墨线。
- 平板：`.site-nav__wide` 和“更多”的显示切换从 1024 提前到 820（千禧 900），墨水与手帐在 820 到 1023 之间栏目间距为 9px。测法：正式站页面里把站名换成 18 个字符的真实站名，强制显示全部栏目，从 761 到 1030 每 2px 检查名字、栏目、工具按钮是否在同一行、没有横向溢出。
- 年份标题：`.library__group .section-title` 与 `.works__group .section-title` 改为 15px 无衬线灰字，分组下边距 36 → 26；第一批里手机端对年份标题的单独缩小一并删掉。
- 相册：宽度 600 以上，含图片的分栏改成网格，每栏用 `subgrid` 共享行轨道（预留 120 行，多出的行高度为 0）。
- 搜索：`readableExcerpt` 在出现表格分隔行时，把第一个到最后一个“|”之间折成“（表格）”，搜索页与快捷搜索共用；有单元测试。
- 等宽数字与面包屑点按区域，见决策记录。

## 怎么验证的

- 原型阶段：正式站真实内容（动态页 2 倍、820 宽首页、影视、相册、书籍 390、课程 390、搜索）注入样式拍对照，每页访问一次。
- 实现之后：见合并请求（本机构建在发布检查结束后进行，避免与检查抢同一台机器）。

## 限制与下一项

- 十六（作者国籍前缀）由用户安排 Codex 修改 Notion 数据，前端不处理。
- 手机课程页要滑几屏才到目录（R-05）：要在 #545 上线后，按新版课程页重新拍原型。
- 下一批是动效与主题类：收起动画（M-02）、悬停曲线（M-05）、看大图箭头与计数（X-04）、名字笔划是否每次重播（X-06）、深色卡片层次（C-02）、页脚“回到顶部”（H-05）、苹果与千禧的切换动效（M-04）、千禧字形（C-03）；首页“最新”与作品卡尺寸（H-01）单独问。
