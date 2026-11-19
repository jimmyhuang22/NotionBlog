# 2026-11-19：首页在玩的游戏改成和作品行一样（Claude）

编辑登记：Claude 修改 `src/components/home-timeline.tsx`、`src/app/timeline.css`，新增决策 [首页在玩的游戏改成和作品行一样](../decisions/2026-11-19-home-game-frames.md)。契约、接口与媒体路由、取数层、fixtures、栏目开关、依赖、站点配置与后端代码未改。

## 改了什么

- `GameLine`：用作品行的 `.work-line` 结构：144×81 封面，图上时钟加时长，标题单独一行；图对读屏隐藏，时长在标题后读出。
- 日期后的标签由 `gameTag` 写成“在 Switch 上玩”这类句子。
- 删掉旧的游戏行样式（`.event--line`、`.event__square` 等，`timeline.css`）。

## 怎么验证的

- 原型阶段在线上首页临时改样子比较过。
- 实现后：本机正式构建加临时预览页（未提交，已删除），把线上 `/api/home/feed-v2?limit=16` 的回应接进 `HomeTimeline`：墨水 1280、岛屿 390、深色 1280。首页三款游戏的标签分别是“在 Switch 上玩”“在 PC 上玩”“在 PC 上玩”，图上是时长，和作品行的图对齐；没有横向溢出。
- Node 24.21.0：`npm run check` 与 `npm run build`，结果见合并请求。

## 限制

- 两个平台的写法（“在 PC、PlayStation 上玩”）只按代码看过，首页现在没有这样的游戏。
