# README 界面截图

这些 PNG 是本项目已有页面的实际浏览器截图，使用仓库默认的离线演示，不是设计稿。

- 数据：`fixtures/content.ts`、`fixtures/expand.ts` 中的虚构记录。
- 身份：通用 NotionBlog 名称与字母头像，没有个人配置。
- 运行：`npm run dev -- --port 3188 --webpack`，服务仅监听本机回环；开发隔离与浏览器 CSP 阻止真实来源和外部媒体连接。
- 取景：1440 × 960、浅色模式。隐藏开发工具浮层，等待正文与本地字体完成加载；没有修改应用组件、样式或演示数据。
- 字体：离线模式下 Nunito 的网络下载被现有守卫阻止，使用应用本来的系统字体回退；未为截图放开网络。

| 文件 | 演示路径 | 主题 |
| --- | --- | --- |
| `home-ink.png` | `/` | 墨水 |
| `home-apple.png` | `/` | 苹果 |
| `home-island.png` | `/` | 岛屿 |
| `home-y2k.png` | `/` | 千禧 |
| `reading.png` | `/study/demo101/notes/week-4` | 墨水 |
| `blocks.png` | `/preview/blocks` | 墨水 |

## 结构图

`architecture-light.png` 与 `architecture-dark.png` 是 README“内容怎样到达页面”一节的插图，不是截图。原稿是 `architecture.svg`：修改后给根元素加上 `class="dark"` 得到深色版，用浏览器按 1200 × 580、两倍像素渲染成 PNG。

## 作者网站截图

`live-*.jpg` 来自作者用本项目搭建的公开网站，是真实记录，不是演示数据。2026-10-23 用无头 Chrome 截取，1440 × 960、浅色墨水主题，一页只访问一次，等可见封面加载完成；没有改动页面。存成 JPEG 并去掉了元数据。相册页含能看出所在地的照片，没有收录。

| 文件 | 页面 |
| --- | --- |
| `live-works.jpg` | 作品（B 站） |
| `live-movies.jpg` | 影视，选中 2024 年 |
| `live-books.jpg` | 书籍，默认视图 |
| `live-games.jpg` | 游戏，选中 2023 年 |

## 许可

演示截图与结构图随原创源码的 MIT 许可证提供；依赖字体仍遵守各自许可证。作者网站截图里的个人记录不在 MIT 授权范围内，影视、书籍、游戏与视频封面归各自的版权方所有。本目录不包含浏览器配置、运行日志或截图工具的私人回执。
