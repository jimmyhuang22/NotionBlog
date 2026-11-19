# 2026-11-19：首页作品行改成“小图带数字”（Claude）

编辑登记：Claude 修改 `src/components/home-works.tsx`、`src/components/home-timeline.tsx`、`src/app/timeline.css`、`tests/reading-design-refinement.test.ts`，新增决策 [首页作品行改成“小图带数字”](../decisions/2026-11-19-home-work-frames.md)。契约、接口与媒体路由、取数层、fixtures、栏目开关、依赖、站点配置与后端代码未改。

## 改了什么

- `HomeWorkLine`：小图 144×81（小红书从顶部裁），图上是播放或点赞、合集个数和“+N”；标题单独一行；图对读屏隐藏，内容在标题后读出。
- `HomeTimeline`：日期后的“作品”标签前面放平台标志（`WorksTag`，几件作品时每个平台一个）。
- 新 `FigureMark`：“播放”“点赞”画成图标（读屏仍读文字），用在补充行和没有封面的清单里。
- 样式：`.work-line__thumb` 144×81，新增 `.work-line__stats`、`.work-line__new`，补充行缩进跟着加宽。

## 怎么验证的

- 原型阶段在线上首页用浏览器临时改样子，墨水电脑、岛屿手机、千禧、深色都看过。
- 实现后：本机正式构建加临时预览页（未提交，已删除），把线上 `/api/home/feed-v2?limit=16` 的真实回应接进 `HomeTimeline`：墨水 1280、390，千禧 1280，深色 1280。B 站合集《杀戮尖塔2》图上是“▶ 6.2万”“叠层 180”和“+1”，小红书那条是 144×81、从顶部裁、爱心 215；“作品”标签里各有平台标志；没有横向溢出。
- `tests/reading-design-refinement.test.ts` 的三条轻记录测试按新样子重写。
- Node 24.21.0：`npm run check` 与 `npm run build`，结果见合并请求。

## 限制

- 连续两三件不同日子的作品，标题下写日期的样子只在测试里覆盖，没在真实数据里看过。
