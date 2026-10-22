# 2026-10-17：课程不再显示“难度”与“推荐”（Claude）

编辑登记：Claude 本轮修改 `src/app/study/page.tsx`、`src/app/study/[course]/page.tsx`、`src/app/study.css`（删掉不再用的 `.course-card__meta`），新增决策记录。契约、接口与媒体路由、fixtures、依赖、栏目开关、全局入口与后端代码未改。

决定见 [决策记录](../decisions/2026-10-17-drop-course-difficulty-recommendation.md)。

验证（只在演示数据下）：本机开发服务器，学习首页 390 宽两张课程卡都只有代码与课程名、没有评价行；演示课程 demo101 的课程页评价只剩“体验”“实用”。类型检查、测试与构建见合并请求说明。

限制：“体验”“实用”仍按原样显示（多数是“未评价”），用户只点名了难度与推荐；正式站点要发布后看。
