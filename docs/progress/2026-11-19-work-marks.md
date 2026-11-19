# 2026-11-19：首页作品行只留彩色平台标志（Claude）

编辑登记：Claude 修改 `src/components/home-timeline.tsx`、`src/app/timeline.css`、`docs/decisions/2026-11-19-home-work-frames.md`，新增决策 [首页作品行只留彩色平台标志](../decisions/2026-11-19-work-marks.md)。契约、接口与媒体路由、取数层、fixtures、栏目开关、依赖、站点配置与后端代码未改。

## 改了什么

- `WorksTag` 改成 `.work-marks`：只有平台标志（16 像素，平台色），没有“作品”和标签底；读屏读“B 站作品”。
- 删掉 `.tag--social` 的样式，新增 `.work-marks`。

## 怎么验证的

- 原型阶段在线上首页临时改样子比较过（浅色、深色、岛屿手机）。
- 实现后：本机正式构建加临时预览页（未提交，已删除），接线上首页数据：墨水 1280（B 站 `rgb(0,135,184)`、小红书 `rgb(255,36,66)`）、深色（B 站 `rgb(0,161,214)`）、岛屿 390、千禧 1280。
- Node 24.21.0：`npm run check` 与 `npm run build`，结果见合并请求。
