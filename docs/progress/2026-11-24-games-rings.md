# 2026-11-24：游戏页“年轮”（Claude）

编辑登记：Claude 修改以下文件：

- `src/app/library/[type]/page.tsx`：游戏页改成大幕、状态标签、年轮；
- `src/components/recent-games.tsx`：最近在玩改成大幕，读取失败和读取中跟着改；
- `src/components/game-tools.tsx`（新增）：状态标签和底部浮动坞；
- `src/components/scrolling-segments.tsx`：`Segments` 加 `variant`；
- `src/components/library-grid.tsx`：`GameWall` 改成年轮，新增 `useYearRings` 和一两款年份的摊开卡片；
- `src/components/section-waiting.tsx`：游戏页的加载形状；
- `src/lib/library.ts`（新增 `gameYearFacts`）、`src/lib/cover-tint.ts`（新增）；
- `src/app/library.css`、`src/app/skins.css`（状态标签沿用书架年份行的各外观短线）。

新增 `tests/games-rings.test.ts`。文档新增 [决策](../decisions/2026-11-24-games-rings.md)，更新 `docs/FRONTEND_GUIDE.md` 游戏库一条，`docs/BACKEND_HANDOFF.md` 加第二十二节（平台筛选）。契约、fixtures、接口、依赖、栏目开关都没改。

## 做了什么

- 大幕：大盒子、名字、小胶囊、8 只小盒子（标签页，← → 换），换的时候盒子从小图位置飞上来，背景交叉淡化，底色取自封面。
- 状态标签在大幕下面、和盒子对齐，手写体大字，默认通关；滚出屏幕后底部升起磨砂浮动坞。排序按钮去掉。
- 年轮：描边大年份随阅读填实，竖线跟着填；每年款数，全部加载后加总时长和各平台几款；一两款的年份摊开显示。

## 怎么验证的

- 本机正式构建加未提交的预览页（线上通关、年份统计和全部游戏存成 JSON，翻页和图片经本机代理读线上）。宽度 1440、1024、390，岛屿浅色、墨水深色：9 个年份的款数、总时长、平台数都和线上数据一致；换大幕游戏后标题、胶囊、底色都换了；滚到 2023 时它是当前年份，前三年填满；浮动坞出现；没有横向溢出，没有脚本错误。
- Node 24 下 `npm run check` 与 `npm run build`，结果见合并请求。

## 限制与下一项

- 平台筛选等后端交接包第二十二节。
- 苹果、千禧外观没截图；在玩、想玩只看了代码路径。
- 大幕和下面内容的衔接放到最后做。
- 随下次发布在正式站点复看，包括上海。
