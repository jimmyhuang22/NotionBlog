# 2026-11-19：书籍详情改为“书架与阅读历程”（Claude）

编辑登记：Claude 新增 `src/lib/work-record.ts`（由 `movie-record.ts` 改名并加上书籍的拆法）、`tests/work-record.test.ts`（由 `movie-record.test.ts` 改名），修改 `src/components/work-detail.tsx`、`src/components/rich-document.tsx`（多一个可选的 `topHeading`）、`src/components/library-detail-loading.tsx`、`src/app/library/[type]/[slug]/page.tsx`、`src/app/library.css`、`docs/FRONTEND_GUIDE.md`，新增决策 [书籍详情改为“书架与阅读历程”](../decisions/2026-11-19-book-detail-shelf.md)。契约、接口与媒体路由、取数层、fixtures、栏目开关、依赖、站点配置与后端代码未改。

## 改了什么

- 书籍详情：左栏封面和资料（随页面停留），右边书名、作者、标签、阅读历程、摘录卡片、其余正文、上一本 / 下一本。
- `bookRecord` 把“摘录”拿出来并计数，空条目不算；“感受 / 感想 / 书评”写作“读后感”；目录、空标题不显示。影视的 `movieRecord` 与它共用同一套整理步骤，行为不变（原有 6 条测试照旧通过）。
- 页面里只剩游戏走旧的信息区；旧代码里影视、书籍的分支删掉了。
- 书籍的加载占位换成同样的左右两栏。

## 怎么验证的

- 本机正式构建加临时预览页（未提交，已删除），用线上取下来的真实记录：《1984》（三部分 40 条摘录，感想是图片）、《一只特立独行的猪》（在读 34.6%，有一个空条目）、《三体》（读后感带书签）、《一句顶一万句》（没有日期、没有正文）、《告别圆舞曲》（有“人物”一节）。
  - 墨水浅色 1280、390，深色 1280（向下滚动，左栏停留）；岛屿、千禧、苹果 1280。
  - 没有横向溢出；空条目修好后《一只特立独行的猪》显示 16 条。
- 预览页的“上一本 / 下一本”是照真实标记手写的，日期是占位字。
- `tests/work-record.test.ts` 10 条（影视 6 条、书籍 4 条）。
- Node 24.21.0：`npm run check` 与 `npm run build`，结果见合并请求。

## 限制与下一项

- 线上真实路由没看过；影视（#376）和书籍都要在发布后挑几本旧记录核对。
- 摘录全部显示，摘录特别多的书（《兄弟》约 1.9 万字）页面会很长。
- 游戏详情等用户选方向。
