# 项目开发约定

每次开始先读取 README.md、docs/REQUIREMENTS.md、决策记录和进度记录（`docs/decisions/` 与 `docs/progress/` 下的各项记录，以及 2026-10-12 前的存档 docs/DECISIONS.md 与 docs/PROGRESS.md）。若本地存在 `.local/PROJECT_MEMORY.md`，同时读取其中的用户要求与当前个人配置背景。用户后续明确指令优先。

## 范围与分工

- 首版只启用 Status 与学习区，学习保留课程、周次、活动和知识子页面层级。
- 博客、相册、书籍、影视、游戏保留类型与统一接口，后续按配置启用。
- Codex 负责工程、后端、Notion 接入、权限、媒体、SEO、构建和部署；Claude 负责视觉、页面、组件与交互。
- 使用同一 Next.js + TypeScript 工程。前端只消费 contracts/ 的 DTO 和 src/lib/content/ 的统一入口。
- 共享文件与契约避免并发覆盖；先核对进度记录中的编辑登记，不重建其他代理已完成的页面。

## 分支与合并

- 两条长期分支：`develop` 是日常集成分支；`main` 是线上分支，也是云端站点正式环境的来源，合并到 main 即触发一次线上部署。不直接向这两条分支提交或推送，不强推，不改写它们的历史。
- 每项工作从最新的 develop 开一个短期分支，完成后向 develop 开合并请求（仓库的默认分支仍是 main，`gh pr create` 要写 `--base develop`），合并后删除该分支。一个分支只做一件事；另一方的改动通过合并 develop 取得，不在自己的分支里重做。
- 合并到 develop 前须没有冲突，按影响范围完成本机验证，请求正文写明受检提交、验证方式与限制，并核对实际合入差异；满足后自行普通合并，不等平台检查。已知代码、协议或构建失败仍须先解决。平台运行显示 `SKIPPED` 不算通过，不能把本机通过或跳过写成平台通过，历史 CI 失败／中断记录保留。公开范围、共享契约和正式发布仍按用户明确指令执行。
- 不再要求每次合并都追上最新 develop。合并前核对目标分支的新变化：出现冲突、改动同一逻辑，或涉及本项使用的依赖、契约、fixtures、配置、数据库协议／迁移、检查环境时，先整合相关更新并验证受影响范围；无法判断影响时先整合验证。无关页面或说明记录的更新不触发重同步、重新推送和重复检查。直接合并时核对实际合入的改动与受检改动一致，不借此夹带未审修改；新任务仍从最新 develop 开始。
- 本机验证按改动影响执行。应用代码或构建输入改变时，在工作分支集中运行一次 `npm run check` 与 `npm run build`；后续只有新改动、失败或未解决的集成问题才重复受影响检查。纯说明、进度记录或开发约定文档，只做记录格式、相关链接、差异和 `npm run privacy:check`，无需反复跑工程全套／构建。改变可执行代码、依赖、构建／测试／部署配置、SQL、契约、fixtures 或运行输入不算纯文档。
- 私人准备阶段曾复用的专用 Mac mini 自托管运行器已于 2026-10-22 退役：新旧仓库原生注册均已移除，系统服务已卸载并持久停用。仓库已于 2026-10-23 按用户授权公开，main／develop 的合并请求与手动检查使用标准 GitHub 托管 Ubuntu。新旧仓库均无原生运行器注册，不能仅依赖工作流条件保护本机；不恢复私人运行器或复用其历史回执。无定时验证任务。CI 使用离线演示，不取得真实来源或部署凭据，具体状态与验收见 [检查说明](docs/GITHUB_ACTIONS_RUNNER.md)。
- 自行合并不等于可以跳过用户的决定。下列事项仍然先得到用户确认，再实现与合并：需要用户先看方案的视觉与排版改动；依赖、契约、fixtures、栏目开关和全局入口等共享范围；公开范围、凭据与云端配置；任何对外可见的发布动作。
- 发布：从 develop 向 main 开一个“发布”合并请求，正文列出这次包含的改动与验证状态，针对这次发布的完整集成版本运行 `npm run check`、`npm run build` 并通过平台检查。只由用户合并，任何一方都不得自行合并到 main；用户可以就某一次发布明确指定由某一方代为合并，这种指定只对那一次有效，下一次仍要重新得到。发布使用普通合并，不用压缩或变基，否则两条分支的历史会分叉。线上的紧急修复同样先进 develop，再发布。
- 发布请求打开期间暂缓向 develop 合并，等该发布完成合并后再继续；用户另行明确解除暂停时按其指令执行。develop → main 发布请求的来源会随 develop 更新，开发合并会使发布检查重新排队，所以每次合入 develop 前先核对是否存在未合并的发布请求。暂停期间可以在工作分支继续开发、按影响验证及准备 PR，已完成改动留在分支，不因日常 develop 无需等待平台检查而推进发布来源。此约定只协调 Git 合并，不停用既有业务定时任务；详见 [发布期间的开发合并约定](docs/decisions/2026-10-13-develop-hold-during-release.md)。
- 除发布请求外，不向 main 开合并请求，只改文档的也一样，统一进 develop、随下一次发布上线。每次合并到 main 都会创建一次正式部署并占用部署额度：免费套餐滚动 24 小时内最多 100 次，用完后包括发布在内的所有部署都会被拒绝。平台的“忽略构建步骤”帮不上忙，被它取消的构建同样计入额度。确实必须直接进 main 时先经用户同意，合入后由开请求的一方把 main 同步回 develop：从最新的 develop 开分支、合入 main、向 develop 开合并请求并按上面的条件合并，否则下一个发布请求会冲突。
- main／develop 均启用 PR 合并保护，main 要求完整检查通过且分支为最新；禁止强推和删除，管理员同样受保护。`.github/workflows/check.yml` 使用 Node 24、双锁文件安装、完整 check／build 与只读 GitHub Token；不沿用私人仓库的自托管树缓存或历史通过回执。
- 新仓库已于 2026-10-23 接到原 Vercel 生产项目并完成首次发布，`vercel.json` 保留 main 自动 Git 部署配置；develop 不自动上线。后续仍逐次按发布规则验收和授权。原私人业务运行根继续独立管理，网站代码发布不自动安装或迁移同步／维护程序，见[接续记录](docs/progress/2026-10-23-production-repository-rebind.md)。
- 手动 deploy、redeploy 与部署钩子不受上述 Git 配置控制；只有用户明确要求云端预览或重新部署时才执行，不为日常验证、同步内容或刷新页面重复部署。历史 Preview URL 保持旧代码，不会随 develop 更新。
- Git 上的文字一律用英文：分支名、提交信息、合并请求的标题与正文、代码评审回复。项目文档与界面文案仍用中文。

## 公开与隐私

- Status 指定来源采用 `publication.mode=all`，展示该 data source 中的现有活动记录与未来新增记录。冻结 v1 仅 status 允许整来源；网站 v2 的其他指定来源按各自用户授权启用，不能由 Status 授权扩大范围。
- 学习区按用户 2026-10-12 新决定公开已配置课程来源的全部当前及未来直属课程，以及各课程实际拥有的笔记数据库记录和子页面；逐层验证物理父链，保留中央 deny 及祖先撤回。普通链接、提及、关系、外部数据库视图和引用的同步块不授予公开；关于等其他普通页的父级公开仍不授权后代。冻结 v1 保留旧名单协议，网站自动学习由独立扩展启用；状态、Clear 和阅读状态不是发布开关。
- Notion SDK、Token、真实来源配置与私有快照只能用于服务端。
- 未知日期、评分和封面保留 null；真实 provider 失败时不得静默回退 mock。
- 原开发包、个人记忆与真实配置留在忽略目录。公共文档与 fixtures 不写个人身份、真实来源 ID 或私有正文。
- 提交前运行 `npm run privacy:check`，人工核对暂存内容；更改 gitignore 不会移除已跟踪文件。
- 本干净仓库已于 2026-10-23 按用户明确授权公开；旧归档仓库保持私人。源码公开不扩大内容公开范围，也不授权正式部署或域名切换；个人配置和内容始终不随源码提交。

## 持续记录

需求或决策改变时，同步 docs/REQUIREMENTS.md，并在 `docs/decisions/` 下新建一个文件记录决策；涉及用户身份与真实来源的信息写入忽略的 `.local/PROJECT_MEMORY.md`，不要复制到公共 docs。

每次完成任务在 `docs/progress/` 下新建一个文件，记录修改、接口、provider、验证、局限和下一项。记忆由后续开发读取本地文件形成；文件缺失时不要假装掌握个人配置。

进度记录每项工作一个文件，决策每项一个文件，命名都是 `YYYY-MM-DD-简短英文名.md`，随对应的合并请求一起提交；只新建或修改自己这项工作的文件，格式见 [进度说明](docs/progress/README.md) 与 [决策说明](docs/decisions/README.md)。docs/PROGRESS.md 与 docs/DECISIONS.md 是 2026-10-12 及之前的存档，不再追加：所有请求都在同一个文件顶部加一节时，任意两个同时打开的请求都会在 GitHub 上冲突（`.gitattributes` 的两边都保留只在本机生效），`npm run check` 会拒绝两份存档里晚于该日期的小节。

模板化暂为探索方向：保持来源映射、接口与栏目开关可配置，先完成首版。暂不开发多租户或自动建库平台。


<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
