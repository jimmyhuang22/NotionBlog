# 2026-11-21：前端清理与提速（Claude）

用户先要一次前端代码审查（发布 #409 尚未部署时），看完报告后选“A 和 B 一起”：A 组是纯前端、低风险、不改外观的清理；B 组是动全局入口的两项提速。

编辑登记：Claude 修改 `src/app/{globals,library,prose,skins,study,timeline}.css`，`src/app/{about,blog,library,library/[type],photos,projects,search,status}/loading.tsx`，`src/app/{blog,projects,photos}/[slug]/page.tsx`，`src/components/` 下的 about-dialog、contact-card、course-tree、cover-image、lightbox、nav-links、page-outline、page-switch、reading-outline、scrolling-segments、search-palette、section-waiting、sort-toggle、status-body、study-overview、study-reading-directory、theme-toggle、use-dismiss、use-fade-in、use-paged-list、work-strip、works-shell，`src/lib/{game-trophies,search}.ts`；新增 `src/lib/{dom,read-api,detail-route}.ts`、`src/components/{pill,island-font}.ts`；测试只给 `tests/contact-card.test.ts` 的模块替身补了一项。文档改 `docs/FRONTEND_GUIDE.md` 的“代码怎么组织”。没有改接口、契约、fixtures、依赖、栏目开关和 `src/app/api`、`src/app/media`。

## 提速

- **岛屿圆体的字体声明不再每页都下**：`@chinese-fonts/hcqyt` 的 167 条 `@font-face`（121 KB，压缩后 40 KB）原来在 `globals.css` 里，四套主题的每个页面都要先下完才渲染。现在放进 `island-font.ts`，由 `theme-toggle.tsx` 在页面已是岛屿（首屏脚本先设好）或访客选岛屿时动态引入。构建后首页的根样式从约 109 KB 降到 68 KB（压缩后）。
- 笔记页两个“当前标题”追踪器各听滚动、各量全部标题；现在只有屏幕上那一个在量：侧栏目录在它显示时（窄屏隐藏后不量），页内目录按钮在它显示或弹层打开时。
- `page-switch.tsx` 跳详情页时不再每帧查询整个页面区最长 15 秒，改为页面区变化或地址提交时最多每帧看一次；超时仍按最近一次开始计 15 秒。固定栏的位置改成先写后读再写，一次排版。
- `work-strip.tsx` 滚动时每帧最多读一次，两侧渐隐真的变了才重渲染。
- 看大图缩放、拖动时不再在写变换之后再量一次图片宽度。
- 正文末尾的空段落与最后一块的下边距改用 `:nth-last-child(1 of …)`，不再对每一块做“后面的兄弟”`:has()`；全是空段落的正文仍用一条锚在首个子元素上的 `:has()`。

## 合并与清理

- 新的 `src/lib/dom.ts`（`isPlainClick`、`prefersReducedMotion`）替换 14 个组件里各写一遍的判断。
- 新的 `src/lib/read-api.ts` 替换关于弹层、动态展开、快捷搜索、列表翻页四处各自的“取 data／限流算忙”写法。
- 新的 `src/components/pill.ts`：筛选条、作品平台、学习材料类型的滑块定位合成一份；后两处原来只跟窗口缩放，现在也跟行宽变化和字体到达（岛屿圆体晚到时滑块宽度不再停在旧值）。三份滑块 CSS 合成一份。
- 联系我卡片改用 `useMenuDismiss`（新增 `refocus: "inside"`，只在焦点原本在卡片里时送回按钮，与原行为相同）。
- 博客、项目、相册详情页共用 `detail-route.ts`；相册详情页读标题时原来漏了栏目开关，现在栏目关着一次也不读。
- 七个只渲染 `PageLoading` 的 `loading.tsx` 改成一行转出（文件保留，它们决定导航和预取停在哪）。
- 四种作品卡片相同的封面、空白占位、播放点赞条规则合并为选择器列表。
- 奖杯（#405/#408）：平台配色改为复用 `platformChip`（返回类型不再含永远不会出现的 `nintendo`）；按月分组不再每加一个就复制数组；白金渐变的两种颜色收成 `--platinum-light`／`--platinum-deep`。
- `useFadeIn` 不再在第一次加载失败时撤掉占位，重试那 600 毫秒浅色底不会消失、重试成功后照常淡入。
- 作品页的加载占位补上 `role="status"` 与名称。
- 删除无用代码：`kindMarks`、`CoverImage` 从未被传过的 `larger`、`.event__square`、`.event__lead`、`.work-line__head`、墨水“最新”那一笔（先画后被整条撤掉的四条规则）、关于弹层被后文覆盖的旧值（合进一条）、苹果重复的一条、岛屿导航被同一媒体块覆盖的一项、千禧页头站名重复的字号；`study.css` 的 699px 断点改为 699.98px，与另外两处一致。

## 没有做的

- B 组的另一半——`library.css`、`study.css` 按路由拆分——没有做：根布局为每个栏目渲染隐藏的加载模板（`page-switch.tsx` 里的 `SectionWaiting`），换栏目时立刻显示，它们用的正是作品库与学习的样式，拆到路由里会让切换时的占位没有样式；另外路由样式在 Next 里排在 `skins.css` 之后，同权重的主题覆盖会反过来。要做得先把加载模板和主题覆盖一起重排，单独评估。
- `back-to-top.tsx` 每帧量内容栏、作品切换时先插入再量宽度两处没动：省得很少，改成按尺寸变化测量又可能漏掉换页。
- 审查里需要 Codex 或用户定的几项（笔记目录并行读取、相邻条目随详情返回、奖杯查询并行与“能不能查”的缓存、笔记页缓存口径）不在这次范围。

## 验证

- Node 24.21.0：`npm run check` 第一次只有 `tests/contact-card.test.ts` 一项失败（3516 项中 3515 通过）：测试的模块替身不认识联系我卡片新引入的 `./use-dismiss`，给替身补上后该文件通过；lint、类型检查、隐私检查都通过。`npm run build` 通过。
- 演示数据（`CONTENT_PROVIDER=mock SOCIAL_PROVIDER=mock`，`next start`），无界面 Chrome 1280／1300／900 宽：
  - 墨水下首页只请求 4 份样式表，没有岛屿字体声明；从主题菜单换到岛屿后才请求那一份，9 个圆体切片加载，标题用圆体；岛屿下刷新同样在开头就请求。
  - 作品页换平台、点年份后，平台与年份的滑块和当前项位置、宽度误差 0；动态页年份条同样。
  - 正文块：插入“正文·空·正文·空·空”“只有空段落”“提示块末尾空段落”“分栏首尾空段落”四种结构，结尾空段落都隐藏、中间的保留、最后一块下边距为 0；块预览页 10 处末块下边距为 0。
  - 关于弹层：计算样式与改前生效的值一致（宽 460、纵向居中、内边距 32/24/6、间距 10）。
  - 笔记页：1300 宽侧栏目录随滚动标出当前标题；900 宽侧栏隐藏时不标；再放宽后恢复标注。从作品页进学习、从一篇笔记进下一篇，过渡层都按时撤掉。
  - 全程控制台无错误。
- 只在演示数据下验证过。演示数据没有可读的关于页、没有配置联系邮箱、笔记目录只有一条，所以关于弹层只核对了样式，联系我卡片只靠单元测试，页内目录按钮没有在浏览器里看到。

## 下一项

- 发布 #409 合并后再把这个分支合进 develop（发布窗口期间暂缓）。
- 随下次发布在正式站点看：岛屿主题首屏的圆体标题出现时机、长笔记的页内目录按钮、联系我卡片的 Esc 与点外面关闭。
