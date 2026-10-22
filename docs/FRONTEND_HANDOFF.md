# Claude 前端开发交接包

> 2026-10-11 说明：本文件是后端最初交给前端的任务说明，其中列出的页面缺项已全部完成。现状、代码组织与验证方法见 [前端接手说明](FRONTEND_GUIDE.md)；本文件保留作接口与历史参考。

更新：2026-10-11。工程：当前仓库根目录。代码基线：`24f85ac`。

后续后端更新（2026-10-11）：新增兼容的 `getCourseMetadata(courseSlug)` 服务端门面，返回已验证的 `Course | null`，不读取正文。只需课程标题／身份的笔记页面和导航可使用它；需要课程介绍时仍调用 get。HTTP 接口和 DTO 形状不变。目录实现已改为复用允许页元数据、单次操作内父块去重与最多四项并行读取；最终验证见 PROGRESS。

## 阶段结论

真实 Notion 数据链路已跑通，首版后端核心已实现，前端可以继续开发。现有页面是最小联调结构，完整阅读体验尚未完成。接下来 Codex 完善目录读取性能、上游请求可靠性和后续工程工作，Claude 在同一工程完成视觉、页面、正文渲染与交互。

后端已具备只读适配、公开资格与祖先检查、动态分页、课程树、17 类正文 AST、公开内部链接、媒体签名与刷新、受控错误和隐私检查。完整目录、代表正文与媒体通过真实联调；这不表示所有正文和最终 UI 已逐页验收。

首版只启用动态和学习区；其他类型保留契约，栏目保持禁用。仓库保持私人，生产部署、域名与仓库公开按用户后续明确指令执行。

指定 Status 来源采用整来源模式，现有和未来新增活动记录自动展示。学习区仍逐页允许，目前只选一门试读课程及已盘点的全部学习页／子页；父页面公开不自动批准未来学习节点。来源的完成／阅读状态不是发布开关，前端不另建权限规则。

## 开始前读取

读取 [共同约定](../AGENTS.md)、[项目说明](../README.md)、[需求](REQUIREMENTS.md)、[决策](DECISIONS.md)、[进度](PROGRESS.md)和本文件。若本地存在 `.local/PROJECT_MEMORY.md` 与 `.local/FRONTEND_CONTEXT.md`，再读取个人背景和本机联调说明；它们不随仓库分发，不能复制到公共材料。

延续当前 Next.js + TypeScript 工程，不重新初始化。使用 Node.js 24 与 npm，依赖以锁文件为准。修改代码前阅读 `node_modules/next/dist/docs/` 中相关 App Router、服务端／客户端、导航、图片及错误处理文档。

## 页面与缺项

| 页面 | 当前行为 | Claude 要完成 |
| --- | --- | --- |
| `/` | 最近动态和课程的基础入口 | 首页、视觉系统与导航，消费真实汇总 DTO |
| `/status` | 首屏动态、纯文本、日期、记录锚点 | 富文本、分页、空值和失败恢复；完整块正文可按查看意图读取详情 |
| `/study` | 公开课程列表 | 课程入口、缺封面／学期状态、响应式布局 |
| `/study/[course]` | 课程标题、递归目录、独立加载与重试 | 展示课程原始正文，完善目录与阅读导航 |
| `/study/[course]/notes/[slug]` | 面包屑和四类简化正文 | 17 类渲染、富文本、标题层级、目录锚点和移动阅读 |

当前笔记只渲染 heading、paragraph、code、child-page；其余块显示占位。富文本被拼成普通字符串，heading 都写成 h2。课程详情已经返回正文，但课程页未渲染它。动态列表还没有“加载更多”。

已有学习路由 `loading.tsx`、课程目录 `Suspense`、局部重试和目录链接 `prefetch={false}`。正式 UI 保留它们的作用：慢请求可见、目录失败可恢复，避免大量笔记自动预取。

## 数据契约与入口

类型以 [内容 DTO](../contracts/content.ts)和[仓库接口](../contracts/repository.ts)为准。服务端组件通过 [统一门面](../src/lib/content/index.ts)取数：

```ts
import { contentRepository } from "@/lib/content";

const statuses = await contentRepository.list("status", { limit: 12 });
const courses = await contentRepository.list("course");
// courseSlug、noteSlug 从路由或返回数据取得，不填写真实固定编号。
const course = await contentRepository.get("course", courseSlug);
const courseMetadata = await contentRepository.getCourseMetadata(courseSlug);
const tree = await contentRepository.getCourseTree(courseSlug);
const note = await contentRepository.get("study-note", noteSlug);
const home = await contentRepository.getHome();
```

门面是 server-only。客户端组件接收可序列化 DTO；交互取数使用下面的 GET 接口。没有首页 HTTP 接口，首页服务端直接调用 `getHome()`。

| 接口 | 成功结果 | 说明 |
| --- | --- | --- |
| `/api/content/status` | `Page<StatusEntry>` | 动态分页 |
| `/api/content/course` | `Page<Course>` | 课程入口 |
| `/api/content/study-note` | `Page<StudyNote>` | 平面列表，层级导航用课程树 |
| `/api/content/[kind]/[slug]` | `ContentDetail<T>` | `{ item, document }`，不接受查询参数 |
| `/api/study/[course]/tree` | `CourseTree` | 完整公开树 |
| `/api/study/[course]/tree?parentId=…` | `CourseTree` | parentId 是节点 ID，返回其完整嵌套子树，不包含父节点本身 |
| `/media/[assetId]` | 刷新重定向或错误 | 使用 ImageAsset.src，不自行构造；不是 JSON 内容接口 |

内容 API 成功包装为 `{ "data": ... }`，失败为 `{ "error": { "code": "...", "message": "..." } }`，均 `no-store`。媒体成功为 302，未知／无效路径为 404。课程树目前仍读取完整树后裁剪，parentId 不代表读取成本已优化。

首版列表默认 `limit=12`，允许 1–50；均支持 cursor、limit、tag、order，course 额外支持 semester。order 可选 date-desc、date-asc、title-asc；默认课程按标题，其余按日期降序，未知日期在已知日期后。首版没有关键词搜索；study-note 不支持 type、courseId、parentId 列表过滤，status 不支持 status 筛选。未知／重复参数返回 400。

游标不透明，用 `URLSearchParams` 原值传递。筛选、排序或每页数量改变时清空旧游标；真实内容或名单变化也可能使游标失效。带游标请求返回 INVALID_QUERY 时提示列表已更新，提供从第一页重新加载，避免持续重试旧游标。用 hasMore 和 nextCursor 判断下一页，不猜总数、不解析 mock 游标。

| 情况 | 门面／HTTP | UI 行为 |
| --- | --- | --- |
| 无公开记录或子节点 | 空 items／nodes，200 | 空状态 |
| 不存在、未批准、归档、删除或跨课程 | 详情／树为 null，HTTP 404 NOT_FOUND；列表已过滤 | 不可用页面，不推断私有原因 |
| 禁用栏目 | 门面列表为空、详情为 null；HTTP 列表／详情为 404 NOT_FOUND | 首版无该栏目入口 |
| 无效参数或旧游标 | ContentServiceError，400 INVALID_QUERY | 修正查询或重新分页 |
| 上游故障 | 同上，503 CONTENT_UNAVAILABLE | 错误和用户触发重试 |
| 限流／共享冷却 | 同上，503 RATE_LIMITED | 繁忙提示，避免高频轮询 |
| 配置缺失 | 同上，503 MISCONFIGURED | 通用不可用状态，诊断留服务端 |

笔记页保留 `note.item.courseId === courseDetail.item.id` 校验。导航使用 DTO.href、breadcrumbs 和 child-page.target。mock 使用虚构 slug，真实 provider 使用允许页的规范化 ID，不硬编码格式或私有 Notion 地址。Status 当前 href 为 `/status#id`，保留记录锚点；没有 `/status/[slug]` 页面，详情 API 已预留。

## 正文和媒体

先建立可复用的 TextRun 与 ContentDocument 渲染组件，用于课程介绍、学习正文和需要读取详情的动态。

| ContentBlock.type | 必须处理 |
| --- | --- |
| paragraph | 富文本段落 |
| heading | level 1／2／3、block.id 锚点、与页面标题一致的可理解层级 |
| list | ordered、checked 为 null 或布尔值、每项递归 children，任务勾选只读 |
| quote | 引用富文本 |
| callout | tone、可空 icon、text、递归 children |
| toggle | 键盘可操作的展开／收起、title、递归 children |
| code | language、保留换行的 code、caption、长行横向滚动 |
| image | src、alt、可空尺寸、caption、加载与失败状态 |
| divider | 语义分隔 |
| table | 单元格富文本、行／列头标记、窄屏横向滚动 |
| columns | 可空 ratio、各列递归 blocks、窄屏堆叠 |
| bookmark | title、url、可空 description |
| embed | 按 display 显示 link／iframe，可访问标题和打开链接；不自行嵌入未允许地址 |
| child-page | target 非空才链接；null 显示不可用文本，不推断地址 |
| table-of-contents | document.toc 与 heading.id 对应 |
| equation | 安全展示 expression，按需协调公式渲染依赖，不能当 HTML 执行 |
| unsupported | 如实显示 label／格式提示，不静默丢弃 |

TextRun 保留 bold、italic、code、underline、strike、color 和 link：external 用 url，internal 用 href，unavailable 保留文本且不可点击。使用 React 文本转义，不拼接未处理 HTML。

document 为 null 表示正文未加载，空 blocks 表示已知为空；completeness 为 partial 必须有整体提示，即使已有块都能渲染。日期、封面、评分和尺寸 null 不得虚构补值；日期处理保留 DateRange.precision，不用创建时间替代。

StatusEntry.text 是从部分正文块提取的富文本，不是完整 AST 或图片集合。完整正文从详情 document 取得，按用户查看意图请求；不要为列表所有记录自动并发获取详情或根据文本猜附件。

媒体使用返回的应用路径／有意公开的外部地址。站内签名路径访问时重查资格并刷新上游 URL，不把重定向地址写回数据、公共 fixtures 或持久缓存。图片展示避免长期优化／代理缓存绕过当前媒体检查，可用普通 img 或明确关闭图片优化；缓存策略改变与后端协商。

## 实施顺序与分工

1. **正文组件**：17 类、富文本、递归、目录和 partial／空／未加载状态。`fixtures/content.ts` 的 `fixtureDocuments["mock-post-1"]` 包含全部 17 类，可用于组件预览；post 保持禁用。现有学习样例只有四类，不能作为完整渲染验收。
2. **学习区**：课程列表与介绍、递归目录、深层笔记、面包屑、移动导航、加载与失败恢复。
3. **动态和首页**：富文本、分页、防重复请求、空值和错误恢复、首页汇总与首版导航。现有动态 mock 只有两条，可用 limit=1 验证分页，必要时增加虚构样例。
4. **视觉与验收**：统一排版、间距、颜色和状态，检查移动／桌面、键盘和可访问性。视觉尚未定稿，先完成可运行方案，再按反馈调整。

| 范围 | 负责人 |
| --- | --- |
| src/app/ 的 UI 页面、src/components/、样式和展示资源 | Claude；API／媒体 Route Handler 除外 |
| src/server/notion/、src/lib/content/、adapters/、API／媒体路由、公开检查、性能与构建 | Codex |
| contracts/、config/features.ts、依赖／锁文件、全局入口和共享 fixtures | 先查进度中的编辑登记，协调兼容，新增依赖说明用途 |
| 进度文档 | 各自及时更新；个人信息仅写本地忽略文件 |

Claude 开始时在 PROGRESS 登记前端编辑范围；Codex 的后端编辑与目录优化结果同样记录于该文件。目录优化仍保留来源、归属、全部祖先与撤销检查，后续性能和限流恢复以实际验证为准。

现有请求调度仅在同一 JS 进程按 Token 共享，其他 worker／工作区连接仍可能触发限流。持久内容缓存、资格缓存和批量预取尚未启用，不能靠前端缓存正文消除等待。

## 开发与验收

已有本机凭据时保留 `.env.local`。新克隆按 README 初始化默认 mock。需要独立 mock 预览可运行 `CONTENT_PROVIDER=mock npm run dev -- --port 3101`。真实本机预览位置和样本仅见 `.local/FRONTEND_CONTEXT.md`；同一端口已有服务时复用，不将真实内容写入公开截图或静态资产。

前端修改后运行：

```sh
npm run typecheck
npm test
npm run privacy:check
npm run build
git diff --check
```

只为实质行为和风险补必要测试。另在浏览器验收：

- 首页、动态、学习、课程和多层笔记导航完整，深层链接刷新可读，课程不匹配为不可用。
- 虚构预览覆盖 17 类与富文本；真实代表正文覆盖图、表、列、代码和子页，partial／unsupported 提示可见。
- 动态下一页无重复，连续点击受控，结束状态正确，筛选清游标，游标失效可重启。
- 慢目录有反馈，失败／繁忙可重试，空正文与未加载可区分；真实失败不回退演示内容。
- 至少检查窄屏与桌面、长标题／表格／代码、焦点、折叠操作和图片失败。
- 客户端及构建不含凭据／私有配置／快照，未公开链接不可跳回私有 Notion，首版不出现禁用栏目入口。

基线 `24f85ac` 的历史验证：125 项测试、类型、隐私与生产构建通过，11 份追踪清单无私人文件；真实浏览器目录和代表笔记可打开。这不替代前端修改后的检查，也不代表完整 UI 已验收。本次交接实际检查记入 PROGRESS。

## 可直接给 Claude 的启动指令

```text
请在当前 NotionBlog 仓库继续前端开发。先读取 AGENTS.md、CLAUDE.md、README.md、
docs/REQUIREMENTS.md、docs/DECISIONS.md、docs/PROGRESS.md 和
docs/FRONTEND_HANDOFF.md；本机若有 .local/PROJECT_MEMORY.md 与
.local/FRONTEND_CONTEXT.md，一并读取，但不要复制个人内容到公共文件。

真实数据和首版后端核心已跑通，现有页面是联调版。沿用同一工程和统一 DTO，
优先完成 17 类正文／富文本渲染，再完善课程目录、深层笔记、动态分页、首页、
响应式和可访问性。只启用动态与学习，不重新初始化或覆盖本机环境文件，
不在客户端使用 Notion SDK／凭据，不硬编码真实课程、来源或个人身份。

保留学习加载、目录独立 Suspense、局部重试和目录链接关闭预取的行为。
公开规则、媒体、限流和目录性能由 Codex 维护；共享契约／依赖变更先协调。
开始时登记编辑范围，完成后做必要检查和浏览器验收，更新 PROGRESS，
写明实际覆盖、缺项与下一步。先交付可运行前端，不自行生产部署或公开仓库。
```
