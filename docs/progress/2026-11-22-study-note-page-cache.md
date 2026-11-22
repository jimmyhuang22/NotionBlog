# 2026-11-22：学习笔记页缓存甲方案（Codex）

从 `573eda1` 开独立分支，落实 [#416](https://github.com/jimmyhuang22/NotionBlog/pull/416) 第十七节第五项。Next 16.4.0 在原有笔记页设置下将 `/study/[course]/notes/[slug]` 标为 `ƒ`。父布局的 `alwaysFresh()` 无条件调用 `connection()`，且未启用 Cache Components。删除笔记页的 `revalidate`、`freshWhenUncached()` 和相关注释、导入，更新两份缓存说明及需求决定。

Node 24.22.1 的 `npm run check` 3,517 项通过。`npm run build` 通过，笔记路由仍为 `ƒ`，51 项产物隐私追踪及本机自托管冒烟通过。Chrome 离线演示中从周次笔记的目录进入知识子页面，两篇正文及侧栏都正常。独立临时构建模拟目录读取失败，正文仍显示，点击“重试加载目录”发出新的 RSC 请求。

接口与 provider 沿用既有入口。验证范围为本机，未测生产共享缓存开关。在发布 [#409](https://github.com/jimmyhuang22/NotionBlog/pull/409) 打开期间，改动留在工作分支。
