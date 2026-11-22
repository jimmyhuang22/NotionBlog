# 2026-11-22：课程正文与笔记目录并行（Codex）

从 `573eda1` 开独立分支，落实 [#416](https://github.com/jimmyhuang22/NotionBlog/pull/416) 第十七节第一项，只改 `getStudyReadingTree`。笔记布局先等待所属课程元数据，之后入口并行开始读课程正文、目录。`readStudyNote` 配对在更早的请求批次，因此正文读取写入 `courseDetails` 时，已结束的批次不会被拆开。默认关闭共享缓存时，目录资格检查仍可复用已经发起的课程正文的元数据。数据库 v2 的目录查询独立执行并按同一版本完成其自身分页。汇合时核对 `tree.courseId` 与正文所属课程一致。

课程页可以预启目录。两处入口有请求级 memo。若目录碰到 `generateMetadata` 或页面刚发起的 `getCourse(course)`，它可能仍要等待正文提供元数据。要争取 SQL 真正重叠，可先启动目录，让独立课程元数据进入批次，再读正文，代价是冷请求可能多一次课程元数据 SQL。对预启的 promise 接住拒绝，后续仍由目录边界报告错误。笔记布局保留先等课程元数据的次序。并发仍共享现有池和限制。未测生产冷池与共享缓存延迟。

Node 24.22.1 的 `npm run check` 3,517 项通过，`npm run build`、51 项产物隐私追踪与本机自托管冒烟通过。接口、provider 与页面沿用现有入口。在发布 [#409](https://github.com/jimmyhuang22/NotionBlog/pull/409) 打开期间，改动留在工作分支。
